const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PUBLIC_DIR = path.resolve(__dirname, 'public')

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css'
}

const resolveFilePath = urlPath => {
  const cleanPath = urlPath === '/' ? '/index.html' : urlPath
  const filePath = path.join(PUBLIC_DIR, cleanPath)
  // reject anything that escapes PUBLIC_DIR (path traversal)
  if (!filePath.startsWith(PUBLIC_DIR)) return null
  return filePath
}

const MISSING_CONFIG_STUB = `console.error('[moz-agent] project-page/public/config.js is missing. Run: cp project-page/public/config.example.js project-page/public/config.js and fill in your Supabase project values.')
export const SUPABASE_URL = ''
export const SUPABASE_ANON_KEY = ''
`

const handleRequest = (req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname
  const filePath = resolveFilePath(urlPath)
  const missing = !filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()

  if (missing && urlPath === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' })
    res.end(MISSING_CONFIG_STUB)
    return
  }

  if (missing) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  const contentType = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': contentType })
  fs.createReadStream(filePath).pipe(res)
}

const createProjectPageServer = () => http.createServer(handleRequest)

module.exports = { createProjectPageServer, PUBLIC_DIR }
