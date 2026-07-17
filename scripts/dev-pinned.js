const { spawn } = require('node:child_process')
const path = require('node:path')
const { createProjectPageServer } = require('../project-page/server')

const PROJECT_PAGE_PORT = process.env.PROJECT_PAGE_PORT || 4590
const PROFILE_DIR = path.resolve(__dirname, '../.dev-profile')

// Uses a persistent Firefox profile instead of web-ext's default throwaway
// one, so that pinning the extension to the toolbar (done manually once)
// survives across `npm run run:pinned` invocations. First run: pin it by
// hand via the toolbar/extensions menu. Every run after that reuses
// .dev-profile, so it stays pinned.
//
// web-ext regenerates user.js from its own baseline preference set on
// every launch, and that baseline forces a blank/homepage start page for
// predictable dev testing - user.js takes precedence over prefs.js on
// every start, so toggling "restore previous session" in Settings gets
// silently clobbered back the moment web-ext relaunches Firefox, no
// matter how cleanly the previous run shut down. A user-supplied --pref
// wins over web-ext's own baseline on that same key, so pass it explicitly
// rather than relying on whatever's already stored in the profile.
const FIREFOX_PREFS = {
  'browser.startup.page': 3 // 3 = always resume the previous session
}

// Important: web-ext (and Firefox itself) also needs a clean shutdown to
// flush the session store to disk in the first place. Spawning through a
// shell and sending a plain SIGTERM only reaches the shell process, not
// the npx -> web-ext -> Firefox chain underneath it, so Firefox never gets
// a graceful quit and the previous-tabs session never saves. Spawning
// directly (no shell) in its own process group and sending SIGINT to the
// whole group - the signal web-ext listens for to quit Firefox cleanly via
// its remote protocol - fixes that half of it.
const main = async () => {
  const server = createProjectPageServer()
  await new Promise(resolve => server.listen(PROJECT_PAGE_PORT, resolve))
  console.log(`project page: http://localhost:${PROJECT_PAGE_PORT}`)
  console.log(`using persistent profile: ${PROFILE_DIR}`)

  const prefArgs = Object.entries(FIREFOX_PREFS)
    .flatMap(([key, value]) => ['--pref', `${key}=${value}`])

  const webExt = spawn('npx', [
    'web-ext', 'run',
    '--source-dir=extension',
    `--firefox-profile=${PROFILE_DIR}`,
    '--profile-create-if-missing',
    '--keep-profile-changes',
    ...prefArgs
  ], {
    stdio: 'inherit',
    detached: true
  })

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      process.kill(-webExt.pid, 'SIGINT')
    } catch (err) {
      // process group already gone
    }
    // give Firefox a moment to quit cleanly and flush its session store
    // before falling back to a hard kill
    setTimeout(() => {
      try {
        process.kill(-webExt.pid, 'SIGKILL')
      } catch (err) {
        // already exited
      }
    }, 5000)
    server.close()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  webExt.on('exit', code => {
    shutdown()
    process.exit(code || 0)
  })
}

main()
