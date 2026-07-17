export const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co'

export const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY'

// for local dev with `npm run run` this should stay http://localhost:4590
// (see project-page/ and scripts/dev.js) - switch to your real deployed
// domain before shipping, and update the matching entries in
// extension/manifest.json (host_permissions + auth-bridge content script)
export const PROJECT_PAGE_ORIGIN = 'http://localhost:4590'
