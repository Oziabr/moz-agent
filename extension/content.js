// runs on every page (see manifest content_scripts, matching the *://*/*
// host_permissions grant). executes a job's payload.commands array in
// order, one command at a time:
//   { type: 'msg', text }                     - shows an on-page popup
//   { type: '$',  selector, name, attr? }      - single element, named
//   { type: '$$', selector, attr? }            - all matching elements
//   { type: 'wait', ms }                       - pause before the next command
//   { type: 'measureRegion', selector?, itemSelector?, manual? } - either
//     scrolls a selector's element into view (selector mode), or shows an
//     on-page drag-to-select overlay and waits for a person to draw the
//     region by hand (manual: true, no selector). Either way, reports the
//     region's viewport rect plus a shallow inventory of elements inside
//     it. Used internally by background.js's 'screenshot' command (see
//     there) to know what to crop and what's in the crop - the pixel
//     capture itself is a privileged API content scripts can't call, so
//     it isn't a command a job author schedules directly.
// 'attr' is optional on both extractors - textContent (trimmed) is used
// by default, or the given attribute's value when present.
// unrecognized command types (and commands missing a required field)
// are reported back as failed rather than silently skipped, so the
// dispatcher (background.js) can surface that in the job's result.

const POPUP_ID = 'moz-agent-popup'
const POPUP_DISMISS_MS = 8000
const MAX_WAIT_MS = 30000 // caps a single 'wait' so one bad job can't hang the tab's whole queue
const MAX_REGION_ELEMENTS = 200 // caps the element inventory so a broad itemSelector can't blow up the payload
const MANUAL_CROP_TIMEOUT_MS = 60000 // how long to wait for a person to draw a selection before giving up

const showPopup = text => {
  let el = document.getElementById(POPUP_ID)
  if (!el) {
    el = document.createElement('div')
    el.id = POPUP_ID
    el.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      max-width: 320px;
      padding: 12px 16px;
      background: #1f2430;
      color: #f0f0f0;
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      white-space: pre-wrap;
    `
    document.documentElement.appendChild(el)
  }

  el.textContent = text
  clearTimeout(el._mozAgentDismissTimer)
  el._mozAgentDismissTimer = setTimeout(() => el.remove(), POPUP_DISMISS_MS)
}

// null element -> null value, so a missing '$' match is reported as
// { ok: true, name, value: null } rather than a thrown error - the
// absence of a match is a normal, expected outcome for a page parser.
const extractValue = (el, attr) => {
  if (!el) return null
  return attr ? el.getAttribute(attr) : el.textContent.trim()
}

// shows a full-viewport overlay, lets the person drag out a rectangle,
// and resolves with it in viewport coordinates (same coordinate space
// getBoundingClientRect() uses, so it lines up with everything else in
// measureRegion). Rejects on Escape, on a too-small selection, or after
// MANUAL_CROP_TIMEOUT_MS if nobody interacts with it at all.
const startManualCrop = () => new Promise((resolve, reject) => {
  const overlay = document.createElement('div')
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    cursor: crosshair;
    background: rgba(0, 0, 0, 0.15);
  `

  const hint = document.createElement('div')
  hint.textContent = 'Drag to select a region \u00b7 Esc to cancel'
  hint.style.cssText = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 8px 14px;
    background: #1f2430;
    color: #f0f0f0;
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
    border-radius: 8px;
    pointer-events: none;
  `

  const box = document.createElement('div')
  box.style.cssText = `
    position: fixed;
    display: none;
    border: 2px solid #4A90D9;
    background: rgba(74, 144, 217, 0.15);
    pointer-events: none;
  `

  overlay.appendChild(hint)
  overlay.appendChild(box)
  document.documentElement.appendChild(overlay)

  let dragging = false
  let startX = 0
  let startY = 0

  const cleanup = () => {
    clearTimeout(timeoutId)
    window.removeEventListener('keydown', onKeyDown, true)
    overlay.remove()
  }

  const timeoutId = setTimeout(() => {
    cleanup()
    reject(new Error('manual crop timed out waiting for a selection'))
  }, MANUAL_CROP_TIMEOUT_MS)

  const onKeyDown = event => {
    if (event.key !== 'Escape') return
    cleanup()
    reject(new Error('manual crop cancelled'))
  }
  window.addEventListener('keydown', onKeyDown, true)

  const currentRect = event => ({
    x: Math.min(startX, event.clientX),
    y: Math.min(startY, event.clientY),
    width: Math.abs(event.clientX - startX),
    height: Math.abs(event.clientY - startY)
  })

  overlay.addEventListener('mousedown', event => {
    dragging = true
    startX = event.clientX
    startY = event.clientY
    box.style.display = 'block'
    box.style.left = `${startX}px`
    box.style.top = `${startY}px`
    box.style.width = '0px'
    box.style.height = '0px'
    event.preventDefault()
  })

  overlay.addEventListener('mousemove', event => {
    if (!dragging) return
    const rect = currentRect(event)
    box.style.left = `${rect.x}px`
    box.style.top = `${rect.y}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
  })

  overlay.addEventListener('mouseup', event => {
    if (!dragging) return
    dragging = false
    const rect = currentRect(event)
    cleanup()
    if (rect.width < 4 || rect.height < 4) {
      reject(new Error('selection too small'))
      return
    }
    resolve(rect)
  })
})

const rectsOverlap = (a, b) =>
  a.left < b.x + b.width && a.right > b.x && a.top < b.y + b.height && a.bottom > b.y

const inventoryElements = (candidates, regionRect) =>
  candidates
    .slice(0, MAX_REGION_ELEMENTS)
    .map(el => {
      const r = el.getBoundingClientRect()
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        className: typeof el.className === 'string' && el.className ? el.className : null,
        text: el.textContent.trim().slice(0, 200),
        // relative to the region's own top-left, not the viewport - lines
        // up directly with pixels in the cropped screenshot image
        rect: { x: r.left - regionRect.x, y: r.top - regionRect.y, width: r.width, height: r.height }
      }
    })

const runCommand = async command => {
  if (command.type === 'msg') {
    showPopup(String(command.text ?? ''))
    return { ok: true }
  }

  if (command.type === '$') {
    if (!command.selector) return { ok: false, reason: "'$' command requires a selector" }
    if (!command.name) return { ok: false, reason: "'$' command requires a name" }
    const el = document.querySelector(command.selector)
    return { ok: true, name: command.name, value: extractValue(el, command.attr) }
  }

  if (command.type === '$$') {
    if (!command.selector) return { ok: false, reason: "'$$' command requires a selector" }
    const values = Array.from(document.querySelectorAll(command.selector))
      .map(el => extractValue(el, command.attr))
    return { ok: true, count: values.length, values }
  }

  if (command.type === 'wait') {
    const ms = Number(command.ms)
    if (!Number.isFinite(ms) || ms < 0) return { ok: false, reason: "'wait' command requires a non-negative 'ms'" }
    const waited = Math.min(ms, MAX_WAIT_MS)
    await new Promise(resolve => setTimeout(resolve, waited))
    return { ok: true, waited }
  }

  if (command.type === 'measureRegion') {
    let regionRect
    let elements

    if (command.manual) {
      try {
        regionRect = await startManualCrop()
      } catch (err) {
        return { ok: false, reason: String(err.message || err) }
      }
      // no single container element in manual mode - scan the page for
      // whatever overlaps the drawn rectangle instead of a fixed parent's
      // own descendants.
      const candidates = Array.from(document.querySelectorAll(command.itemSelector || '*'))
        .filter(el => rectsOverlap(el.getBoundingClientRect(), regionRect))
      elements = inventoryElements(candidates, regionRect)
    } else {
      if (!command.selector) return { ok: false, reason: "'measureRegion' command requires a selector, or manual: true" }
      const container = document.querySelector(command.selector)
      if (!container) return { ok: false, reason: 'element not found' }

      container.scrollIntoView({ block: 'center', inline: 'center' })
      // let scroll settle and the browser paint the new position before we
      // measure - getBoundingClientRect() right after scrollIntoView() can
      // still reflect the pre-scroll layout on some pages.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

      const r = container.getBoundingClientRect()
      regionRect = { x: r.left, y: r.top, width: r.width, height: r.height }
      elements = inventoryElements(Array.from(container.querySelectorAll(command.itemSelector || '*')), regionRect)
    }

    return {
      ok: true,
      rect: regionRect,
      devicePixelRatio: window.devicePixelRatio || 1,
      elements
    }
  }

  return { ok: false, reason: `unknown command type: ${command.type}` }
}

// sequential, not Promise.all - a 'wait' is only useful if it actually
// delays whatever comes after it in the same job.
const runCommands = async commands => {
  const list = Array.isArray(commands) ? commands : []
  const results = []
  for (const command of list) {
    results.push(await runCommand(command))
  }
  return results
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'runJob') return false
  runCommands(message.payload?.commands).then(results => sendResponse({ ok: true, results }))
  return true // keep the message channel open for the async sendResponse above
})
