import {
  getSession,
  setSession,
  signOut,
  selectRows,
  upsertRow,
  updateRows,
  eq,
  inList
} from './supabase-client.js'

const TABLE_DOMAINS = 'moz_agent_enabled_domains'
const TABLE_JOBS = 'moz_agent_jobs'

const BADGE_COLOR_OFF = '#888780'
const BADGE_COLOR_READ = '#4A90D9'
const BADGE_COLOR_WRITE = '#D9822B'
const BADGE_COLOR_JOBS = '#3FB68B'
const BADGE_COLOR_MISMATCH = '#E2504A'

const POLL_ALARM_NAME = 'moz-agent-poll'
const POLL_INTERVAL_MINUTES = 1

const domainCache = new Map()
let activeJobCounts = new Map()
let isAuthenticated = false

const getHostname = url => {
  try {
    return new URL(url).hostname
  } catch (err) {
    return null
  }
}

const hasHostPermission = domain =>
  browser.permissions.contains({ origins: [`*://${domain}/*`] })

const requestHostPermission = domain =>
  browser.permissions.request({ origins: [`*://${domain}/*`] })

const removeHostPermission = domain =>
  browser.permissions.remove({ origins: [`*://${domain}/*`] })

const badgeForState = (state, jobCount) => {
  if (jobCount > 0) return { text: String(jobCount), color: BADGE_COLOR_JOBS }
  if (!state || !state.enabled) return { text: '', color: BADGE_COLOR_OFF }
  if (state.grantMismatch) return { text: '!', color: BADGE_COLOR_MISMATCH }
  if (state.allowWrite) return { text: 'W', color: BADGE_COLOR_WRITE }
  return { text: 'R', color: BADGE_COLOR_READ }
}

const setBadgeForTab = async (tabId, domain) => {
  const state = domain ? domainCache.get(domain) : null
  const jobCount = domain ? (activeJobCounts.get(domain) || 0) : 0
  const badge = badgeForState(state, jobCount)
  await browser.action.setBadgeText({ tabId, text: badge.text })
  await browser.action.setBadgeBackgroundColor({ tabId, color: badge.color })
}

const refreshActiveTabBadge = async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab) return
  const domain = getHostname(tab.url)
  await setBadgeForTab(tab.id, domain)
}

const loadDomainState = async () => {
  if (!isAuthenticated) {
    domainCache.clear()
    return
  }

  const { data, error } = await selectRows(TABLE_DOMAINS)
  if (error) {
    console.error('moz-agent: failed to load enabled domains', error)
    return
  }

  domainCache.clear()
  data.forEach(row => domainCache.set(row.domain, { enabled: row.enabled, allowWrite: row.allow_write }))

  const grantChecks = await Promise.all(
    data.map(row => hasHostPermission(row.domain).then(granted => ({ domain: row.domain, granted })))
  )
  grantChecks
    .filter(check => !check.granted)
    .forEach(check => {
      const state = domainCache.get(check.domain)
      if (state) state.grantMismatch = true
    })
}

const refreshJobCounts = async () => {
  if (!isAuthenticated) {
    activeJobCounts = new Map()
    await refreshActiveTabBadge()
    return
  }

  const { data, error } = await selectRows(TABLE_JOBS, {
    columns: 'domain',
    filters: { status: inList(['pending', 'claimed']) }
  })
  if (error) {
    console.error('moz-agent: failed to load job counts', error)
    return
  }

  const counts = new Map()
  data.forEach(row => counts.set(row.domain, (counts.get(row.domain) || 0) + 1))
  activeJobCounts = counts
  await refreshActiveTabBadge()
}

const pollNow = async () => {
  await loadDomainState()
  await refreshJobCounts()
  await refreshActiveTabBadge()
}

const startPolling = () => browser.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES })

const stopPolling = () => browser.alarms.clear(POLL_ALARM_NAME)

const setDomainEnabled = async (domain, enabled) => {
  if (!isAuthenticated) return { ok: false, reason: 'not authenticated' }

  if (enabled) {
    const granted = await requestHostPermission(domain)
    if (!granted) return { ok: false, reason: 'permission request denied' }
  } else {
    await removeHostPermission(domain)
  }

  const currentWrite = domainCache.get(domain)?.allowWrite || false
  const { error } = await upsertRow(
    TABLE_DOMAINS,
    { domain, enabled, allow_write: enabled ? currentWrite : false },
    { onConflict: 'user_id,domain' }
  )
  if (error) return { ok: false, reason: error }

  domainCache.set(domain, { enabled, allowWrite: enabled ? currentWrite : false })
  await refreshActiveTabBadge()
  return { ok: true }
}

const setDomainWrite = async (domain, allowWrite) => {
  if (!isAuthenticated) return { ok: false, reason: 'not authenticated' }

  const state = domainCache.get(domain)
  if (!state || !state.enabled) return { ok: false, reason: 'domain is not enabled' }

  const { error } = await updateRows(TABLE_DOMAINS, { allow_write: allowWrite }, { domain: eq(domain) })
  if (error) return { ok: false, reason: error }

  state.allowWrite = allowWrite
  await refreshActiveTabBadge()
  return { ok: true }
}

// called on startup (existing persisted session) and whenever the auth
// bridge relays a session change from the project page. resets everything
// scoped to the previous identity before loading the new one - RLS means
// stale cached rows from a different user must never linger.
const applyAuthState = async () => {
  const session = await getSession()
  isAuthenticated = Boolean(session)

  stopPolling()
  domainCache.clear()
  activeJobCounts = new Map()

  if (isAuthenticated) {
    await pollNow()
    startPolling()
  }

  await refreshActiveTabBadge()
}

const handleAuthHandoff = async session => {
  if (session) await setSession(session)
  else await signOut()

  await applyAuthState()
  return { ok: true }
}

const handleMessage = (message, sender, sendResponse) => {
  if (message.type === 'getState') {
    const state = domainCache.get(message.domain) || { enabled: false, allowWrite: false }
    sendResponse(state)
    return false
  }

  if (message.type === 'getAuthState') {
    sendResponse({ authenticated: isAuthenticated })
    return false
  }

  if (message.type === 'setEnabled') {
    setDomainEnabled(message.domain, message.enabled)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: err.message }))
    return true
  }

  if (message.type === 'setWrite') {
    setDomainWrite(message.domain, message.allowWrite)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: err.message }))
    return true
  }

  if (message.type === 'authHandoff') {
    handleAuthHandoff(message.session)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: err.message }))
    return true
  }

  return false
}

browser.runtime.onMessage.addListener(handleMessage)
browser.tabs.onActivated.addListener(refreshActiveTabBadge)
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') refreshActiveTabBadge()
})
browser.windows.onFocusChanged.addListener(refreshActiveTabBadge)
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM_NAME) pollNow()
})

applyAuthState()
