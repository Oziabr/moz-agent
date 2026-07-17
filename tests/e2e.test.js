const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { Builder } = require('selenium-webdriver')
const firefox = require('selenium-webdriver/firefox')
const geckodriver = require('geckodriver')
const { prepareTestExtension } = require('./prepare-test-extension')

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/index.html')

const startFixtureServer = () => new Promise(resolve => {
  const server = http.createServer((req, res) => {
    fs.createReadStream(FIXTURE_PATH).pipe(res)
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})

const buildDriver = async () => {
  const geckoPath = await geckodriver.download()
  const service = new firefox.ServiceBuilder(geckoPath)
  const options = new firefox.Options().addArguments('-headless')
  if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN)
  return new Builder()
    .forBrowser('firefox')
    .setFirefoxService(service)
    .setFirefoxOptions(options)
    .build()
}

const callBridge = (driver, type, payload = {}) =>
  driver.executeAsyncScript(
    (bridgeType, bridgePayload, callback) => {
      window.mozAgentTest.call(bridgeType, bridgePayload).then(callback)
    },
    type,
    payload
  )

test('moz-agent e2e', async t => {
  const server = await startFixtureServer()
  const port = server.address().port
  const driver = await buildDriver()

  t.after(async () => {
    await driver.quit()
    server.close()
  })

  await driver.installAddon(prepareTestExtension(), true)
  await driver.manage().setTimeouts({ script: 3000 })
  await driver.get(`http://127.0.0.1:${port}/`)

  await t.test('unknown domain defaults to disabled', async () => {
    const state = await callBridge(driver, 'getState', { domain: 'example.com' })
    assert.equal(Boolean(state.enabled), false)
  })

  await t.test('enabling a domain succeeds without a user gesture (pure DB write)', async () => {
    const result = await callBridge(driver, 'setEnabled', { domain: 'example.com', enabled: true })
    assert.equal(result.ok, true)

    const state = await callBridge(driver, 'getState', { domain: 'example.com' })
    assert.equal(Boolean(state.enabled), true)
  })

  await t.test('allow-write succeeds once the domain is enabled', async () => {
    const result = await callBridge(driver, 'setWrite', { domain: 'example.com', allowWrite: true })
    assert.equal(result.ok, true)

    const state = await callBridge(driver, 'getState', { domain: 'example.com' })
    assert.equal(Boolean(state.allowWrite), true)
  })

  await t.test('allow-write is blocked on a domain that is not enabled', async () => {
    const result = await callBridge(driver, 'setWrite', { domain: 'other.example', allowWrite: true })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'domain is not enabled')
  })
})
