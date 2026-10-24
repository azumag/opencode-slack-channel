// Mock Slack (Web API + Socket Mode) for the Linux kit's container test (after
// claude-slack-channel's mock). Runs inside the proxy container on 127.0.0.1,
// under the name slack.mock that only the proxy resolves: the VM container
// reaches it through the HTTP proxy or not at all.
//
// Test control (from the host, via docker exec curl):
//   GET  /control/state   → what the mock saw (API calls, sockets, connected now)
//   POST /control/reset   → forget it (each e2e run starts clean)
//   POST /control/drop    → cut every socket (the bridge reconnects)
//
// Zero dependencies: the WebSocket server side is the minimal RFC 6455 subset
// the bridge needs (text frames, ping, close).

import { createHash } from 'node:crypto'
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 9100)
const BOT_TOKEN = process.env.MOCK_BOT_TOKEN || 'xoxb-test-bot'
const APP_TOKEN = process.env.MOCK_APP_TOKEN || 'xapp-test-app'

const state = { slackCalls: [], acks: 0, sockets: 0, unknown: [] }
const sockets = new Set()

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
  })
}

function slack(method, req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  state.slackCalls.push(method)
  if (method === 'api.test') return json(res, 200, { ok: true })
  if (method === 'apps.connections.open') {
    if (token !== APP_TOKEN) return json(res, 200, { ok: false, error: 'invalid_auth' })
    return json(res, 200, { ok: true, url: 'ws://slack.mock:' + PORT + '/socket' })
  }
  if (token !== BOT_TOKEN) return json(res, 200, { ok: false, error: 'invalid_auth' })
  if (method === 'auth.test') return json(res, 200, { ok: true, user: 'opencode', user_id: 'U0C9Y2F2HEV', bot_id: 'B0OPENCODE1', team: 'mockteam' })
  state.unknown.push('slack ' + method)
  return json(res, 200, { ok: false, error: 'unknown_method' })
}

function frame(text) {
  const payload = Buffer.from(text)
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : null
  if (!head) throw new Error('frame too large for the mock')
  return Buffer.concat([head, payload])
}

function onUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  sockets.add(socket)
  state.sockets += 1
  socket.write(frame(JSON.stringify({ type: 'hello', num_connections: 1 })))
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15
      let len = buffer[1] & 127
      let offset = 2
      if (len === 126) { len = buffer.readUInt16BE(2); offset = 4 }
      else if (len === 127) { len = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      const masked = (buffer[1] & 128) !== 0
      const total = offset + (masked ? 4 : 0) + len
      if (buffer.length < total) break
      const mask = masked ? buffer.subarray(offset, offset + 4) : null
      const data = Buffer.from(buffer.subarray(total - len, total))
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]
      buffer = buffer.subarray(total)
      if (opcode === 1) {
        try { if (JSON.parse(data.toString()).envelope_id) state.acks += 1 } catch { /* ignore */ }
      } else if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]))
      } else if (opcode === 9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]))
      }
    }
  })
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => sockets.delete(socket))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock')
  await readBody(req)
  if (url.pathname.startsWith('/api/')) return slack(url.pathname.slice(5), req, res)
  if (url.pathname === '/control/state') return json(res, 200, { ...state, connected: sockets.size })
  if (url.pathname === '/control/drop') {
    const dropped = sockets.size
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    return json(res, 200, { dropped })
  }
  if (url.pathname === '/control/reset') {
    Object.assign(state, { slackCalls: [], acks: 0, sockets: 0, unknown: [] })
    return json(res, 200, { ok: true })
  }
  if (url.pathname === '/') { res.writeHead(200); return res.end('mock slack') }
  state.unknown.push(req.method + ' ' + url.pathname)
  json(res, 404, { error: 'mock: unknown path' })
})
server.on('upgrade', onUpgrade)
server.listen(PORT, '127.0.0.1', () => console.log('mock slack on 127.0.0.1:' + PORT))
