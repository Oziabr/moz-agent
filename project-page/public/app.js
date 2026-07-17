import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

const AUTH_URL = `${SUPABASE_URL}/auth/v1`
const REST_URL = `${SUPABASE_URL}/rest/v1`
const SESSION_KEY = 'moz_agent_project_session'

const els = {
  loginSection: document.getElementById('login-section'),
  loginForm: document.getElementById('login-form'),
  loginEmail: document.getElementById('login-email'),
  loginStatus: document.getElementById('login-status'),
  domainsSection: document.getElementById('domains-section'),
  domainsBody: document.getElementById('domains-body'),
  logoutButton: document.getElementById('logout-button'),
  whoami: document.getElementById('whoami')
}

// tells the extension's auth-bridge.js content script about the current
// session (or its absence). see extension/auth-bridge.js and the README's
// Auth section for the contract.
const broadcastSession = session =>
  window.dispatchEvent(new CustomEvent('moz-agent-session', { detail: { session } }))

const readStoredSession = () => {
  const raw = localStorage.getItem(SESSION_KEY)
  return raw ? JSON.parse(raw) : null
}

const writeStoredSession = session => localStorage.setItem(SESSION_KEY, JSON.stringify(session))

const clearStoredSession = () => localStorage.removeItem(SESSION_KEY)

// magic link redirects land back here with tokens in the URL hash, e.g.
// #access_token=...&refresh_token=...&expires_in=3600&token_type=bearer
const sessionFromRedirectHash = () => {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  const params = new URLSearchParams(hash)
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  if (!accessToken || !refreshToken) return null

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + Number(params.get('expires_in') || 3600)
  }
}

const clearRedirectHash = () => window.history.replaceState(null, '', window.location.pathname)

const requestMagicLink = async email => {
  const redirectTo = window.location.origin + window.location.pathname
  const response = await fetch(`${AUTH_URL}/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, create_user: true })
  })
  if (!response.ok) throw new Error(await response.text())
}

const fetchDomains = async session => {
  const response = await fetch(`${REST_URL}/moz_agent_enabled_domains?select=*&order=domain`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` }
  })
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

const renderDomains = domains => {
  els.domainsBody.innerHTML = ''
  domains.forEach(row => {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${row.domain}</td>
      <td>${row.enabled ? 'yes' : 'no'}</td>
      <td>${row.allow_write ? 'yes' : 'no'}</td>
    `
    els.domainsBody.appendChild(tr)
  })
  if (domains.length === 0) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td colspan="3">no domains enabled yet - use the extension popup</td>'
    els.domainsBody.appendChild(tr)
  }
}

const showLoggedIn = async session => {
  els.loginSection.hidden = true
  els.domainsSection.hidden = false
  els.whoami.textContent = 'connected'
  try {
    renderDomains(await fetchDomains(session))
  } catch (err) {
    els.whoami.textContent = `connected, but failed to load domains: ${err.message}`
  }
}

const showLoggedOut = () => {
  els.loginSection.hidden = false
  els.domainsSection.hidden = true
}

const handleLogin = async event => {
  event.preventDefault()
  els.loginStatus.textContent = 'sending link...'
  try {
    await requestMagicLink(els.loginEmail.value)
    els.loginStatus.textContent = 'check your email for a magic link'
  } catch (err) {
    els.loginStatus.textContent = `failed: ${err.message}`
  }
}

const handleLogout = async () => {
  clearStoredSession()
  broadcastSession(null)
  showLoggedOut()
}

const init = async () => {
  if (!SUPABASE_URL) {
    els.loginStatus.textContent =
      'config.js is missing - run: cp project-page/public/config.example.js project-page/public/config.js'
    return
  }

  const redirectSession = sessionFromRedirectHash()
  if (redirectSession) {
    writeStoredSession(redirectSession)
    clearRedirectHash()
  }

  const session = redirectSession || readStoredSession()
  if (session) {
    broadcastSession(session)
    await showLoggedIn(session)
  } else {
    showLoggedOut()
  }
}

els.loginForm.addEventListener('submit', handleLogin)
els.logoutButton.addEventListener('click', handleLogout)

init()
