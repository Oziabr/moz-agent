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

const fetchJobs = async session => {
  const columns = 'id,domain,type,status,created_at,error,result'
  const response = await fetch(`${REST_URL}/moz_agent_jobs?select=${columns}&order=created_at.desc`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` }
  })
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

const HTML_ESCAPES = [[/&/g, '&amp;'], [/</g, '&lt;'], [/>/g, '&gt;'], [/"/g, '&quot;']]

// job result/error text can contain arbitrary content scraped from
// whatever page the job ran against - unlike domain names (typed through
// the extension popup), that's not something this page controls, so it
// gets escaped before going into innerHTML.
const escapeHtml = text => HTML_ESCAPES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), String(text))

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}...` : text)

const formatTimestamp = iso => new Date(iso).toLocaleString()

const groupJobsByDomain = jobs => {
  const map = new Map()
  jobs.forEach(job => {
    const list = map.get(job.domain) || []
    list.push(job)
    map.set(job.domain, list)
  })
  return map
}

// done -> a truncated preview of the result, failed -> the error message,
// pending/claimed -> nothing yet to show
const jobSummary = job => {
  if (job.status === 'failed') return job.error || ''
  if (job.status === 'done') return job.result ? JSON.stringify(job.result) : ''
  return ''
}

const renderJobsTable = jobs => {
  if (jobs.length === 0) return '<div class="jobs-empty">no jobs yet</div>'

  const rows = jobs.map(job => `
    <tr>
      <td>${escapeHtml(job.type)}</td>
      <td class="job-status-${escapeHtml(job.status)}">${escapeHtml(job.status)}</td>
      <td>${escapeHtml(formatTimestamp(job.created_at))}</td>
      <td>${escapeHtml(truncate(jobSummary(job), 120))}</td>
    </tr>
  `).join('')

  return `
    <table class="jobs-table">
      <thead><tr><th>Type</th><th>Status</th><th>Created</th><th>Result / error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `
}

const renderDomains = (domains, jobsByDomain) => {
  els.domainsBody.innerHTML = ''
  domains.forEach(row => {
    const domainRow = document.createElement('tr')
    domainRow.innerHTML = `
      <td>${escapeHtml(row.domain)}</td>
      <td>${row.enabled ? 'yes' : 'no'}</td>
      <td>${row.allow_write ? 'yes' : 'no'}</td>
    `
    els.domainsBody.appendChild(domainRow)

    const jobsRow = document.createElement('tr')
    jobsRow.className = 'jobs-row'
    jobsRow.innerHTML = `<td colspan="3">${renderJobsTable(jobsByDomain.get(row.domain) || [])}</td>`
    els.domainsBody.appendChild(jobsRow)
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
    const [domains, jobs] = await Promise.all([fetchDomains(session), fetchJobs(session)])
    renderDomains(domains, groupJobsByDomain(jobs))
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
