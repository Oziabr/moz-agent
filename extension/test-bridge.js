const respond = (id, result) =>
  window.dispatchEvent(new CustomEvent('moz-agent-test-response', { detail: { id, result } }))

const handleRequest = event => {
  const { id, type, domain, enabled, allowWrite } = event.detail
  browser.runtime.sendMessage({ type, domain, enabled, allowWrite })
    .then(result => respond(id, result))
    .catch(err => respond(id, { ok: false, reason: err.message }))
}

window.addEventListener('moz-agent-test-request', handleRequest)
