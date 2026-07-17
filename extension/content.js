// runs on every page (see manifest content_scripts, matching the *://*/*
// host_permissions grant). executes a job's payload.commands array,
// one command type at a time. today only 'msg' is implemented - it shows
// a small on-page popup with the given text. unrecognized command types
// are reported back as failed rather than silently ignored, so the
// dispatcher (background.js) can surface that in the job's result.

const POPUP_ID = 'moz-agent-popup'
const POPUP_DISMISS_MS = 8000

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

const runCommand = command => {
  if (command.type === 'msg') {
    showPopup(String(command.text ?? ''))
    return { ok: true }
  }
  return { ok: false, reason: `unknown command type: ${command.type}` }
}

const runCommands = commands => (Array.isArray(commands) ? commands : []).map(runCommand)

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'runJob') return false
  sendResponse({ ok: true, results: runCommands(message.payload?.commands) })
  return false
})
