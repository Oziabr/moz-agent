const store = {
  moz_agent_enabled_domains: [],
  moz_agent_jobs: []
}

const uniqueKeyMatch = (table, row) =>
  entry => table === 'moz_agent_enabled_domains' && entry.domain === row.domain

class QueryBuilder {
  constructor(table, mode, extra = {}) {
    this.table = table
    this.mode = mode
    this.filters = []
    this.row = extra.row || null
    this.patch = extra.patch || null
    this.selectCols = extra.selectCols || null
  }

  eq(col, val) {
    this.filters.push(entry => entry[col] === val)
    return this
  }

  in(col, vals) {
    this.filters.push(entry => vals.includes(entry[col]))
    return this
  }

  then(resolve, reject) {
    try {
      resolve(this.run())
    } catch (err) {
      reject ? reject(err) : resolve({ data: null, error: err })
    }
  }

  run() {
    const rows = store[this.table]

    if (this.mode === 'select') {
      const matched = rows.filter(entry => this.filters.every(check => check(entry)))
      return { data: matched, error: null }
    }

    if (this.mode === 'upsert') {
      const idx = rows.findIndex(uniqueKeyMatch(this.table, this.row))
      if (idx >= 0) rows[idx] = { ...rows[idx], ...this.row }
      else rows.push({ user_id: 'test-user', ...this.row })
      return { data: null, error: null }
    }

    if (this.mode === 'update') {
      rows
        .filter(entry => this.filters.every(check => check(entry)))
        .forEach(entry => Object.assign(entry, this.patch))
      return { data: null, error: null }
    }

    return { data: null, error: new Error(`unsupported mode ${this.mode}`) }
  }
}

const fromTable = table => ({
  select: () => new QueryBuilder(table, 'select'),
  upsert: row => new QueryBuilder(table, 'upsert', { row }),
  update: patch => new QueryBuilder(table, 'update', { patch })
})

const fakeChannel = () => ({
  on: () => fakeChannel(),
  subscribe: () => ({})
})

export const createClient = () => ({
  from: fromTable,
  channel: fakeChannel,
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'test-user' } } } }),
    signInAnonymously: async () => ({ data: { session: { user: { id: 'test-user' } } }, error: null })
  }
})
