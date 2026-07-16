const store = {
  moz_agent_enabled_domains: [],
  moz_agent_jobs: []
}

let session = {
  access_token: 'test-token',
  refresh_token: 'test-refresh',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'test-user' }
}

export const eq = value => ({ op: 'eq', value })

export const inList = values => ({ op: 'in', values })

const matches = (row, filters) =>
  Object.entries(filters).every(([col, condition]) => {
    if (condition.op === 'eq') return row[col] === condition.value
    if (condition.op === 'in') return condition.values.includes(row[col])
    return true
  })

export const getSession = async () => session

export const setSession = async rawSession => {
  session = {
    access_token: rawSession.access_token,
    refresh_token: rawSession.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'test-user' }
  }
  return session
}

export const signOut = async () => {
  session = null
}

export const selectRows = async (table, { filters = {} } = {}) => {
  const rows = store[table].filter(row => matches(row, filters))
  return { data: rows, error: null }
}

export const upsertRow = async (table, row) => {
  const idx = store[table].findIndex(entry => entry.domain === row.domain)
  if (idx >= 0) store[table][idx] = { ...store[table][idx], ...row }
  else store[table].push({ user_id: 'test-user', ...row })
  return { error: null }
}

export const updateRows = async (table, patch, filters) => {
  store[table]
    .filter(row => matches(row, filters))
    .forEach(row => Object.assign(row, patch))
  return { error: null }
}
