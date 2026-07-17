// runs on every page (see manifest content_scripts, matching the *://*/*
// host_permissions grant). executes a job's payload.commands array in
// order, one command at a time:
//   { type: 'msg', text }                     - shows an on-page popup
//   { type: '$',  selector, name, attr? }      - single element, named
//   { type: '$$', selector, attr? }            - all matching elements
//   { type: 'wait', ms }                       - pause before the next command
//   { type: 'measureRegion', selector, itemSelector? } - scrolls a region
//     into view and reports its viewport rect plus a shallow inventory of
//     elements inside it. Used internally by background.js's 'screenshot'
//     command (see there) to know what to crop and what's in the crop -
//     the pixel capture itself is a privileged API content scripts can't
//     call, so it isn't a command a job author schedules directly.
// 'attr' is optional on both extractors - textContent (trimmed) is used
// by default, or the given attribute's value when present.
// unrecognized command types (and commands missing a required field)
// are reported back as failed rather than silently skipped, so the
// dispatcher (background.js) can surface that in the job's result.

const POPUP_ID = 'moz-agent-popup'
const POPUP_DISMISS_MS = 8000
const MAX_WAIT_MS = 30000 // caps a single 'wait' so one bad job can't hang the tab's whole queue
const MAX_REGION_ELEMENTS = 200 // caps the element inventory so a broad itemSelector can't blow up the payload

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
    if (!command.selector) return { ok: false, reason: "'measureRegion' command requires a selector" }
    const container = document.querySelector(command.selector)
    if (!container) return { ok: false, reason: 'element not found' }

    container.scrollIntoView({ block: 'center', inline: 'center' })
    // let scroll settle and the browser paint the new position before we
    // measure - getBoundingClientRect() right after scrollIntoView() can
    // still reflect the pre-scroll layout on some pages.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    const containerRect = container.getBoundingClientRect()
    const elements = Array.from(container.querySelectorAll(command.itemSelector || '*'))
      .slice(0, MAX_REGION_ELEMENTS)
      .map(el => {
        const r = el.getBoundingClientRect()
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          className: typeof el.className === 'string' && el.className ? el.className : null,
          text: el.textContent.trim().slice(0, 200),
          // relative to the container's top-left, not the viewport - lines
          // up directly with pixels in the cropped screenshot image
          rect: { x: r.left - containerRect.left, y: r.top - containerRect.top, width: r.width, height: r.height }
        }
      })

    return {
      ok: true,
      rect: { x: containerRect.left, y: containerRect.top, width: containerRect.width, height: containerRect.height },
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
