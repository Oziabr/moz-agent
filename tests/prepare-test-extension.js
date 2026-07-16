const fs = require('node:fs')
const path = require('node:path')

const SOURCE_DIR = path.resolve(__dirname, '../extension')
const OUTPUT_DIR = path.resolve(__dirname, '../.test-extension')
const STUB_CLIENT = path.resolve(__dirname, 'fixtures/supabase-client.stub.js')

const prepareTestExtension = () => {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
  fs.cpSync(SOURCE_DIR, OUTPUT_DIR, { recursive: true })
  fs.copyFileSync(STUB_CLIENT, path.join(OUTPUT_DIR, 'supabase-client.js'))
  return OUTPUT_DIR
}

module.exports = { prepareTestExtension }
