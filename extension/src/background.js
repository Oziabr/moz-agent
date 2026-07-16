import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

const TABLE_DOMAINS = 'moz_agent_enabled_domains'
const TABLE_JOBS = 'moz_agent_jobs'

const BADGE_COLOR_OFF = '#888780'
const BADGE_COLOR_READ = '#4A90D9'
const BADGE_COLOR_WRITE = '#D9822B'
const BADGE_COLOR_JOBS = '#3FB68B'
const BADGE_COLOR_MISMATCH = '#E2504A'

// MV3 event pages in Firefox can be torn down and respawned when idle, so
// session persistence rides on browser.storage.local rather than the
// default localStorage - it survives across those restarts reliably.
const browserStorageAdapter = {
  getItem: async key => {
    const result = await browser.storage.local.get(key)
    return result[key] ?? null
  },
  setItem: async (key, value) => {
    await browser.storage.local.set({ [key]: value })
  },
  removeItem: async key => {
    await browser.storage.local.remove(key)
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: browserStorageAdapter,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
})

const domainCache = new Map()
let activeJobCounts = new Map()
let isAuthenticated = false
let domainsChannel = null
let jobsChannel = null

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

  const { data, error } = await supabase.from(TABLE_DOMAINS).select('*')
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

  const { data, error } = await supabase
    .from(TABLE_JOBS)
    .select('domain')
    .in('status', ['pending', 'claimed'])
  if (error) {
    console.error('moz-agent: failed to load job counts', error)
    return
  }

  const counts = new Map()
  data.forEach(row => counts.set(row.domain, (counts.get(row.domain) || 0) + 1))
  activeJobCounts = counts
  await refreshActiveTabBadge()
}

const setDomainEnabled = async (domain, enabled) => {
  if (!isAuthenticated) return { ok: false, reason: 'not authenticated' }

  if (enabled) {
    const granted = await requestHostPermission(domain)
    if (!granted) return { ok: false, reason: 'permission request denied' }
  } else {
    await removeHostPermission(domain)
  }

  const currentWrite = domainCache.get(domain)?.allowWrite || false
  const { error } = await supabase
    .from(TABLE_DOMAINS)
    .upsert(
      { domain, enabled, allow_write: enabled ? currentWrite : false },
      { onConflict: 'user_id,domain' }
    )
  if (error) return { ok: false, reason: error.message }

  domainCache.set(domain, { enabled, allowWrite: enabled ? currentWrite : false })
  await refreshActiveTabBadge()
  return { ok: true }
}

const setDomainWrite = async (domain, allowWrite) => {
  if (!isAuthenticated) return { ok: false, reason: 'not authenticated' }

  const state = domainCache.get(domain)
  if (!state || !state.enabled) return { ok: false, reason: 'domain is not enabled' }

  const { error } = await supabase
    .from(TABLE_DOMAINS)
    .update({ allow_write: allowWrite })
    .eq('domain', domain)
  if (error) return { ok: false, reason: error.message }

  state.allowWrite = allowWrite
  await refreshActiveTabBadge()
  return { ok: true }
}

const loadDomainStateAndRefresh = async () => {
  await loadDomainState()
  await refreshActiveTabBadge()
}

const teardownRealtime = () => {
  if (domainsChannel) supabase.removeChannel(domainsChannel)
  if (jobsChannel) supabase.removeChannel(jobsChannel)
  domainsChannel = null
  jobsChannel = null
}

const subscribeRealtime = () => {
  if (!isAuthenticated) return

  domainsChannel = supabase
    .channel('moz_agent_enabled_domains_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE_DOMAINS }, loadDomainStateAndRefresh)
    .subscribe()

  jobsChannel = supabase
    .channel('moz_agent_jobs_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE_JOBS }, refreshJobCounts)
    .subscribe()
}

// called on startup (existing persisted session) and whenever the auth
// bridge relays a session change from the project page. resets everything
// scoped to the previous identity before loading the new one - RLS means
// stale cached rows from a different user must never linger.
const applyAuthState = async () => {
  const { data: { session } } = await supabase.auth.getSession()
  isAuthenticated = Boolean(session)

  teardownRealtime()
  domainCache.clear()
  activeJobCounts = new Map()

  if (isAuthenticated) {
    await loadDomainState()
    await refreshJobCounts()
    subscribeRealtime()
  }

  await refreshActiveTabBadge()
}

const handleAuthHandoff = async session => {
  if (session) {
    const { error } = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token
    })
    if (error) {
      console.error('moz-agent: failed to adopt session from project page', error)
      return { ok: false, reason: error.message }
    }
  } else {
    await supabase.auth.signOut()
  }

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

applyAuthState()
