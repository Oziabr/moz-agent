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

const handleRequest = (req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname
  const filePath = resolveFilePath(urlPath)

  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
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
