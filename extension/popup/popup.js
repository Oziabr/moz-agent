import { PROJECT_PAGE_ORIGIN } from '../config.js'

const els = {
  domain: document.getElementById('domain'),
  status: document.getElementById('status'),
  enableToggle: document.getElementById('enable-toggle'),
  writeToggle: document.getElementById('write-toggle'),
  toggles: document.getElementById('toggles'),
  connect: document.getElementById('connect'),
  connectButton: document.getElementById('connect-button')
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

const showConnectPrompt = () => {
  els.connect.hidden = false
  els.toggles.hidden = true
  els.domain.textContent = ''
  els.status.textContent = 'not connected'
}

const showToggles = () => {
  els.connect.hidden = true
  els.toggles.hidden = false
}

const load = async () => {
  const { authenticated } = await browser.runtime.sendMessage({ type: 'getAuthState' })
  if (!authenticated) {
    showConnectPrompt()
    return
  }
  showToggles()

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

els.connectButton.onclick = () => browser.tabs.create({ url: PROJECT_PAGE_ORIGIN })

document.addEventListener('DOMContentLoaded', load)
