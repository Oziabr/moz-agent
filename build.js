const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const isTest = process.argv.includes('--test')

const OTEL_IMPORT_PATTERN = /otelModulePromise\s*=\s*import\(([\s\S]*?)\)\s*\.catch/

const stripOtelDynamicImport = {
  name: 'strip-otel-dynamic-import',
  setup(build) {
    build.onLoad({ filter: /\.(js|mjs|cjs)$/ }, args => {
      const contents = fs.readFileSync(args.path, 'utf8')
      if (!contents.includes('@opentelemetry/api')) return null
      const patched = contents.replace(OTEL_IMPORT_PATTERN, 'otelModulePromise = Promise.resolve(null).catch')
      return { contents: patched, loader: 'js' }
    })
  }
}

const targets = [
  { in: 'extension/src/background.js', out: 'extension/background.js' },
  { in: 'extension/src/popup.js', out: 'extension/popup/popup.js' }
]

const buildOne = target =>
  esbuild.build({
    entryPoints: [target.in],
    outfile: target.out,
    bundle: true,
    format: 'iife',
    target: 'firefox128',
    plugins: [stripOtelDynamicImport],
    alias: isTest
      ? { '@supabase/supabase-js': path.resolve(__dirname, 'extension/src/supabase-stub.js') }
      : {}
  })

const run = async () => {
  for (const target of targets) await buildOne(target)
  fs.copyFileSync('extension/src/test-bridge.js', 'extension/test-bridge.js')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
