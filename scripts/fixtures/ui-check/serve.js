// Static server for the ui-check fixtures: node serve.js <port>. /api/* answers {"ok":true}.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}') }
  const file = path.join(__dirname, path.normalize(url.pathname === '/' ? '/good.html' : url.pathname))
  if (!file.startsWith(__dirname) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(Number(process.argv[2]), '127.0.0.1')
