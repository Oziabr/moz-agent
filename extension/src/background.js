import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

const TABLE_DOMAINS = 'moz_agent_enabled_domains'
const TABLE_JOBS = 'moz_agent_jobs'

const BADGE_COLOR_OFF = '#888780'
const BADGE_COLOR_READ = '#4A90D9'
const BADGE_COLOR_WRITE = '#D9822B'
const BADGE_COLOR_JOBS = '#3FB68B'
const BADGE_COLOR_MISMATCH = '#E2504A'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const domainCache = new Map()
let activeJobCounts = new Map()

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

const subscribeRealtime = () => {
  supabase
    .channel('moz_agent_enabled_domains_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE_DOMAINS }, loadDomainStateAndRefresh)
    .subscribe()

  supabase
    .channel('moz_agent_jobs_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE_JOBS }, refreshJobCounts)
    .subscribe()
}

const handleMessage = (message, sender, sendResponse) => {
  if (message.type === 'getState') {
    const state = domainCache.get(message.domain) || { enabled: false, allowWrite: false }
    sendResponse(state)
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

  return false
}

browser.runtime.onMessage.addListener(handleMessage)
browser.tabs.onActivated.addListener(refreshActiveTabBadge)
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') refreshActiveTabBadge()
})
browser.windows.onFocusChanged.addListener(refreshActiveTabBadge)

const init = async () => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) await supabase.auth.signInAnonymously()
  await loadDomainState()
  await refreshJobCounts()
  await refreshActiveTabBadge()
  subscribeRealtime()
}

init()
