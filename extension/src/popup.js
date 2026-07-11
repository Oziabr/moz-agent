const els = {
  domain: document.getElementById('domain'),
  status: document.getElementById('status'),
  enableToggle: document.getElementById('enable-toggle'),
  writeToggle: document.getElementById('write-toggle')
}

const getCurrentDomain = async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  try {
    return new URL(tab.url).hostname
  } catch (err) {
    return null
  }
}

const renderState = (domain, state) => {
  els.domain.textContent = domain
  els.enableToggle.checked = Boolean(state.enabled)
  els.writeToggle.checked = Boolean(state.allowWrite)
  els.writeToggle.disabled = !state.enabled
  els.status.textContent = state.enabled
    ? (state.allowWrite ? 'enabled, can submit forms' : 'enabled, read-only')
    : 'disabled'
}

const onEnableChange = domain => async () => {
  const requested = els.enableToggle.checked
  els.status.textContent = 'updating...'
  const result = await browser.runtime.sendMessage({ type: 'setEnabled', domain, enabled: requested })
  if (!result.ok) {
    els.enableToggle.checked = !requested
    els.status.textContent = `failed: ${result.reason}`
    return
  }
  const nextState = await browser.runtime.sendMessage({ type: 'getState', domain })
  renderState(domain, nextState)
}

const onWriteChange = domain => async () => {
  const requested = els.writeToggle.checked
  els.status.textContent = 'updating...'
  const result = await browser.runtime.sendMessage({ type: 'setWrite', domain, allowWrite: requested })
  if (!result.ok) {
    els.writeToggle.checked = !requested
    els.status.textContent = `failed: ${result.reason}`
    return
  }
  const nextState = await browser.runtime.sendMessage({ type: 'getState', domain })
  renderState(domain, nextState)
}

const load = async () => {
  const domain = await getCurrentDomain()
  if (!domain) {
    els.domain.textContent = 'no domain'
    els.status.textContent = 'this page has no eligible domain'
    els.enableToggle.disabled = true
    els.writeToggle.disabled = true
    return
  }

  const state = await browser.runtime.sendMessage({ type: 'getState', domain })
  renderState(domain, state)

  els.enableToggle.onchange = onEnableChange(domain)
  els.writeToggle.onchange = onWriteChange(domain)
}

document.addEventListener('DOMContentLoaded', load)
