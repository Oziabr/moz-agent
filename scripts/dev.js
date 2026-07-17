const { spawn } = require('node:child_process')
const { createProjectPageServer } = require('../project-page/server')

const PROJECT_PAGE_PORT = process.env.PROJECT_PAGE_PORT || 4590

const main = async () => {
  const server = createProjectPageServer()
  await new Promise(resolve => server.listen(PROJECT_PAGE_PORT, resolve))
  console.log(`project page: http://localhost:${PROJECT_PAGE_PORT}`)

  const webExt = spawn('npx', ['web-ext', 'run', '--source-dir=extension'], {
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
