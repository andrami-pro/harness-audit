// Static server for the ui-check fixtures: node serve.js <port> [hits-file].
// /stuck-once.html never answers its first request and serves good.html from the second: a tab that stopped loading.
// /api/* answers {"ok":true}; with a hits file, the pid and every /api/ path requested are appended to it, so a check
// can prove a destructive button was never pressed and that ui-check stopped this server.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const log = process.argv[3]
let stuck = 0
if (log) fs.appendFileSync(log, `pid ${process.pid}\n`)
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.startsWith('/api/')) {
    if (log) fs.appendFileSync(log, `${url.pathname}\n`)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"ok":true}')
  }
  if (url.pathname === '/stuck-once.html' && stuck++ === 0) return
  const file = path.join(__dirname, path.normalize(url.pathname === '/' || url.pathname === '/stuck-once.html' ? '/good.html' : url.pathname))
  if (!file.startsWith(__dirname) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(Number(process.argv[2]), '127.0.0.1')
