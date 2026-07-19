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
  whoami: document.getElementById('whoami'),
  newDomain: document.getElementById('new-domain'),
  enableDomainButton: document.getElementById('enable-domain-button'),
  enableDomainWriteButton: document.getElementById('enable-domain-write-button'),
  domainActionStatus: document.getElementById('domain-action-status'),
  knownDomains: document.getElementById('known-domains'),
  actionDomain: document.getElementById('action-domain'),
  jobType: document.getElementById('job-type'),
  commandBuilder: document.getElementById('command-builder'),
  commandsContainer: document.getElementById('commands-container'),
  addCommandButton: document.getElementById('add-command-button'),
  rawPayloadWrap: document.getElementById('raw-payload-wrap'),
  rawPayload: document.getElementById('raw-payload'),
  scheduleActionButton: document.getElementById('schedule-action-button'),
  actionStatus: document.getElementById('action-status')
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

const eq = value => `eq.${encodeURIComponent(value)}`

const restHeaders = (session, extra) => ({
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${session.access_token}`,
  'Content-Type': 'application/json',
  ...extra
})

// see docs/db-examples.md - same shape as extension/supabase-client.js's
// upsertRow/updateRows, just against this page's localStorage-backed
// session instead of browser.storage.
const upsertRow = async (session, table, row, { onConflict } = {}) => {
  const query = onConflict ? `?on_conflict=${onConflict}` : ''
  const response = await fetch(`${REST_URL}/${table}${query}`, {
    method: 'POST',
    headers: restHeaders(session, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row)
  })
  if (!response.ok) throw new Error(await response.text())
}

const updateRows = async (session, table, patch, filters) => {
  const query = Object.entries(filters).map(([col, condition]) => `${col}=${condition}`).join('&')
  const response = await fetch(`${REST_URL}/${table}?${query}`, {
    method: 'PATCH',
    headers: restHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify(patch)
  })
  if (!response.ok) throw new Error(await response.text())
}

// -- domain actions (docs/db-examples.md "Enable a domain" section) --

const enableDomain = (session, domain) =>
  upsertRow(session, 'moz_agent_enabled_domains', { domain, enabled: true }, { onConflict: 'user_id,domain' })

const enableDomainForWrite = (session, domain) =>
  upsertRow(
    session,
    'moz_agent_enabled_domains',
    { domain, enabled: true, allow_write: true },
    { onConflict: 'user_id,domain' }
  )

const disableDomain = (session, domain) =>
  updateRows(session, 'moz_agent_enabled_domains', { enabled: false, allow_write: false }, { domain: eq(domain) })

// -- job scheduling (docs/db-examples.md's various "Schedule a ... job" sections) --

const scheduleJob = (session, domain, type, payload) =>
  upsertRow(session, 'moz_agent_jobs', { domain, type, payload })

// one entry per command type content.js/background.js understand - see
// "Schedule a parse job using $ / $$ extractors and wait", "...that
// navigates mid-job", and "...screenshot of a region" in docs/db-examples.md
const COMMAND_FIELDS = {
  msg: [{ name: 'text', label: 'Text', type: 'text' }],
  $: [
    { name: 'selector', label: 'Selector', type: 'text' },
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'attr', label: 'Attribute (optional)', type: 'text' }
  ],
  $$: [
    { name: 'selector', label: 'Selector', type: 'text' },
    { name: 'attr', label: 'Attribute (optional)', type: 'text' }
  ],
  wait: [{ name: 'ms', label: 'Milliseconds (max 30000)', type: 'number' }],
  goto: [{ name: 'url', label: 'URL', type: 'text' }],
  screenshot: [
    { name: 'selector', label: 'Selector (blank = manual drag-select)', type: 'text' },
    { name: 'itemSelector', label: 'Item selector (optional)', type: 'text' }
  ]
}

// builds one payload.commands entry from a command row's type + raw field
// values - the inverse of what each recipe in docs/db-examples.md writes
// by hand.
const buildCommand = (type, values) => {
  switch (type) {
    case 'msg':
      return { type: 'msg', text: values.text || '' }
    case '$': {
      const cmd = { type: '$', selector: values.selector || '', name: values.name || '' }
      if (values.attr) cmd.attr = values.attr
      return cmd
    }
    case '$$': {
      const cmd = { type: '$$', selector: values.selector || '' }
      if (values.attr) cmd.attr = values.attr
      return cmd
    }
    case 'wait':
      return { type: 'wait', ms: Number(values.ms || 0) }
    case 'goto':
      return { type: 'goto', url: values.url || '' }
    case 'screenshot': {
      const cmd = { type: 'screenshot' }
      if (values.selector) cmd.selector = values.selector
      else cmd.manual = true
      if (values.itemSelector) cmd.itemSelector = values.itemSelector
      return cmd
    }
    default:
      throw new Error(`unknown command type: ${type}`)
  }
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

const renderDomains = (domains, jobsByDomain, session) => {
  els.domainsBody.innerHTML = ''
  domains.forEach(row => {
    const domainRow = document.createElement('tr')
    domainRow.innerHTML = `
      <td>${escapeHtml(row.domain)}</td>
      <td>${row.enabled ? 'yes' : 'no'}</td>
      <td>${row.allow_write ? 'yes' : 'no'}</td>
      <td></td>
    `
    const disableButton = document.createElement('button')
    disableButton.type = 'button'
    disableButton.textContent = 'Disable'
    disableButton.disabled = !row.enabled && !row.allow_write
    disableButton.addEventListener('click', () => handleDisableDomain(session, row.domain))
    domainRow.querySelector('td:last-child').appendChild(disableButton)
    els.domainsBody.appendChild(domainRow)

    const jobsRow = document.createElement('tr')
    jobsRow.className = 'jobs-row'
    jobsRow.innerHTML = `<td colspan="4">${renderJobsTable(jobsByDomain.get(row.domain) || [])}</td>`
    els.domainsBody.appendChild(jobsRow)
  })
  if (domains.length === 0) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td colspan="4">no domains enabled yet - use the extension popup, or enable one below</td>'
    els.domainsBody.appendChild(tr)
  }

  els.knownDomains.innerHTML = domains.map(row => `<option value="${escapeHtml(row.domain)}"></option>`).join('')
}

const showLoggedIn = async session => {
  els.loginSection.hidden = true
  els.domainsSection.hidden = false
  els.whoami.textContent = 'connected'
  try {
    const [domains, jobs] = await Promise.all([fetchDomains(session), fetchJobs(session)])
    renderDomains(domains, groupJobsByDomain(jobs), session)
  } catch (err) {
    els.whoami.textContent = `connected, but failed to load domains: ${err.message}`
  }
}

const showLoggedOut = () => {
  els.loginSection.hidden = false
  els.domainsSection.hidden = true
}

const renderCommandFields = type => COMMAND_FIELDS[type].map(field => `
  <label>${field.label}
    <input type="${field.type}" data-field="${field.name}" class="cmd-field">
  </label>
`).join('')

const addCommandRow = () => {
  const row = document.createElement('div')
  row.className = 'cmd-row'
  row.innerHTML = `
    <div class="cmd-row-header">
      <select class="cmd-type">
        ${Object.keys(COMMAND_FIELDS).map(t => `<option value="${t}">${t}</option>`).join('')}
      </select>
      <button type="button" class="cmd-remove">Remove</button>
    </div>
    <div class="cmd-fields">${renderCommandFields('msg')}</div>
  `
  row.querySelector('.cmd-type').addEventListener('change', event => {
    row.querySelector('.cmd-fields').innerHTML = renderCommandFields(event.target.value)
  })
  row.querySelector('.cmd-remove').addEventListener('click', () => row.remove())
  els.commandsContainer.appendChild(row)
}

const readCommandRow = row => {
  const type = row.querySelector('.cmd-type').value
  const values = {}
  row.querySelectorAll('.cmd-field').forEach(input => {
    if (input.value.trim() !== '') values[input.dataset.field] = input.value.trim()
  })
  return buildCommand(type, values)
}

const updateJobTypeUI = () => {
  const isSubmit = els.jobType.value === 'submit'
  els.commandBuilder.hidden = isSubmit
  els.rawPayloadWrap.hidden = !isSubmit
}

const handleEnableDomain = async (session, allowWrite) => {
  const domain = els.newDomain.value.trim()
  if (!domain) {
    els.domainActionStatus.textContent = 'domain is required'
    return
  }
  els.domainActionStatus.textContent = 'saving...'
  try {
    if (allowWrite) await enableDomainForWrite(session, domain)
    else await enableDomain(session, domain)
    els.domainActionStatus.textContent = `${domain} enabled`
    els.newDomain.value = ''
    await showLoggedIn(session)
  } catch (err) {
    els.domainActionStatus.textContent = `failed: ${err.message}`
  }
}

const handleDisableDomain = async (session, domain) => {
  els.domainActionStatus.textContent = `disabling ${domain}...`
  try {
    await disableDomain(session, domain)
    els.domainActionStatus.textContent = `${domain} disabled`
    await showLoggedIn(session)
  } catch (err) {
    els.domainActionStatus.textContent = `failed: ${err.message}`
  }
}

const handleScheduleAction = async session => {
  const domain = els.actionDomain.value.trim()
  if (!domain) {
    els.actionStatus.textContent = 'domain is required'
    return
  }
  const type = els.jobType.value
  els.actionStatus.textContent = 'scheduling...'
  try {
    let payload
    if (type === 'submit') {
      payload = els.rawPayload.value.trim() ? JSON.parse(els.rawPayload.value) : {}
    } else {
      const commands = Array.from(els.commandsContainer.querySelectorAll('.cmd-row')).map(readCommandRow)
      payload = { commands }
    }
    await scheduleJob(session, domain, type, payload)
    els.actionStatus.textContent = 'scheduled'
    await showLoggedIn(session)
  } catch (err) {
    els.actionStatus.textContent = `failed: ${err.message}`
  }
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

els.enableDomainButton.addEventListener('click', () => {
  const session = readStoredSession()
  if (session) handleEnableDomain(session, false)
})
els.enableDomainWriteButton.addEventListener('click', () => {
  const session = readStoredSession()
  if (session) handleEnableDomain(session, true)
})
els.addCommandButton.addEventListener('click', addCommandRow)
els.jobType.addEventListener('change', updateJobTypeUI)
els.scheduleActionButton.addEventListener('click', () => {
  const session = readStoredSession()
  if (session) handleScheduleAction(session)
})

updateJobTypeUI()
addCommandRow()

init()
