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
// silently clobbered back the moment web-ext relaunches Firefox. A
// user-supplied --pref wins over web-ext's own baseline on that same key,
// so pass it explicitly rather than relying on whatever's already stored
// in the profile.
const FIREFOX_PREFS = {
  'browser.startup.page': 3 // 3 = always resume the previous session
}

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
    shell: true
  })

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    webExt.kill()
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
