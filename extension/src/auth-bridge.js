// runs only on the project page origin (see manifest content_scripts match).
// the project page is expected to cooperate by dispatching this event from
// its own supabase.auth.onAuthStateChange listener, e.g.
//
//   supabase.auth.onAuthStateChange((event, session) => {
//     window.dispatchEvent(new CustomEvent('moz-agent-session', { detail: { session } }))
//   })
//
// onAuthStateChange fires once on load with the current session (or null),
// so this also covers the "already logged in" case without reading storage
// directly and coupling to supabase-js's internal key format.

const handleSessionEvent = event => {
  const session = event.detail?.session || null
  browser.runtime.sendMessage({ type: 'authHandoff', session })
}

window.addEventListener('moz-agent-session', handleSessionEvent)
