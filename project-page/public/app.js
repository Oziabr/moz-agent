import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

const AUTH_URL = `${SUPABASE_URL}/auth/v1`
const REST_URL = `${SUPABASE_URL}/rest/v1`
const SESSION_KEY = 'moz_agent_project_session'

const els = {
  loginSection: document.getElementById('login-section'),
  loginForm: document.getElementById('login-form'),
  loginEmail: document.getElementById('login-email'),
  loginPassword: document.getElementById('login-password'),
  signupButton: document.getElementById('signup-button'),
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

const sessionFromTokenResponse = body => ({
  access_token: body.access_token,
  refresh_token: body.refresh_token,
  expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in || 3600)
})

// GoTrue's password grant returns tokens directly in the JSON body, so
// unlike the old magic-link flow there's no redirect round-trip and no
// hash-fragment parsing needed.
const signInWithPassword = async (email, password) => {
  const response = await fetch(`${AUTH_URL}/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error_description || body.msg || JSON.stringify(body))
  return sessionFromTokenResponse(body)
}

// /auth/v1/signup both creates the user and (when email confirmation is
// off) returns a session in the same response - same shape as the
// password grant above.
const signUpWithPassword = async (email, password) => {
  const response = await fetch(`${AUTH_URL}/signup`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error_description || body.msg || JSON.stringify(body))
  if (!body.access_token) {
    throw new Error('signed up - check your email to confirm the account, then log in')
  }
  return sessionFromTokenResponse(body)
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
  els.loginStatus.textContent = 'logging in...'
  try {
    const session = await signInWithPassword(els.loginEmail.value, els.loginPassword.value)
    writeStoredSession(session)
    broadcastSession(session)
    els.loginStatus.textContent = ''
    await showLoggedIn(session)
  } catch (err) {
    els.loginStatus.textContent = `failed: ${err.message}`
  }
}

const handleSignup = async () => {
  els.loginStatus.textContent = 'signing up...'
  try {
    const session = await signUpWithPassword(els.loginEmail.value, els.loginPassword.value)
    writeStoredSession(session)
    broadcastSession(session)
    els.loginStatus.textContent = ''
    await showLoggedIn(session)
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

  const session = readStoredSession()
  if (session) {
    broadcastSession(session)
    await showLoggedIn(session)
  } else {
    showLoggedOut()
  }
}

els.loginForm.addEventListener('submit', handleLogin)
els.signupButton.addEventListener('click', handleSignup)
els.logoutButton.addEventListener('click', handleLogout)

init()
