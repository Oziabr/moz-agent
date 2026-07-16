import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

const AUTH_URL = `${SUPABASE_URL}/auth/v1`
const REST_URL = `${SUPABASE_URL}/rest/v1`
const SESSION_KEY = 'moz_agent_session'
const EXPIRY_SKEW_SECONDS = 30

export const eq = value => `eq.${encodeURIComponent(value)}`

export const inList = values => `in.(${values.map(encodeURIComponent).join(',')})`

const readStoredSession = async () => {
  const result = await browser.storage.local.get(SESSION_KEY)
  return result[SESSION_KEY] || null
}

const writeStoredSession = session => browser.storage.local.set({ [SESSION_KEY]: session })

const clearStoredSession = () => browser.storage.local.remove(SESSION_KEY)

const toSession = body => ({
  access_token: body.access_token,
  refresh_token: body.refresh_token,
  expires_at: body.expires_at || Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
  user: body.user
})

const isExpired = session =>
  !session || !session.expires_at || Date.now() / 1000 > session.expires_at - EXPIRY_SKEW_SECONDS

const refreshSession = async session => {
  const response = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token })
  })
  if (!response.ok) {
    await clearStoredSession()
    return null
  }
  const nextSession = toSession(await response.json())
  await writeStoredSession(nextSession)
  return nextSession
}

// returns the current session, transparently refreshing it if it's near
// expiry. null means signed out.
export const getSession = async () => {
  const stored = await readStoredSession()
  if (!stored) return null
  if (!isExpired(stored)) return stored
  return refreshSession(stored)
}

// adopts a session handed off from the project page (see auth-bridge.js)
export const setSession = async rawSession => {
  const session = toSession(rawSession)
  await writeStoredSession(session)
  return session
}

export const signOut = async () => {
  await clearStoredSession()
}

const restHeaders = async extra => {
  const session = await getSession()
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session ? session.access_token : SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  }
}

const buildQuery = (columns, filters) => {
  const parts = [`select=${columns}`]
  Object.entries(filters).forEach(([col, condition]) => parts.push(`${col}=${condition}`))
  return parts.join('&')
}

export const selectRows = async (table, { columns = '*', filters = {} } = {}) => {
  const url = `${REST_URL}/${table}?${buildQuery(columns, filters)}`
  const response = await fetch(url, { headers: await restHeaders() })
  if (!response.ok) return { data: null, error: await response.text() }
  return { data: await response.json(), error: null }
}

export const upsertRow = async (table, row, { onConflict } = {}) => {
  const query = onConflict ? `?on_conflict=${onConflict}` : ''
  const response = await fetch(`${REST_URL}/${table}${query}`, {
    method: 'POST',
    headers: await restHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row)
  })
  if (!response.ok) return { error: await response.text() }
  return { error: null }
}

export const updateRows = async (table, patch, filters) => {
  const query = Object.entries(filters).map(([col, condition]) => `${col}=${condition}`).join('&')
  const response = await fetch(`${REST_URL}/${table}?${query}`, {
    method: 'PATCH',
    headers: await restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(patch)
  })
  if (!response.ok) return { error: await response.text() }
  return { error: null }
}
