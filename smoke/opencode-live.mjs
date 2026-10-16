// Live smoke test of the opencode half: the real bridge against the REAL
// opencode v2 server, with an in-memory fake Slack. No Slack app needed.
//
//   node smoke/opencode-live.mjs [providerID/modelID]
//
// Checks: a reply comes back in the thread; a shell permission prompt reaches
// "Slack" as buttons and an Allow-once click lets the command run; !stop
// interrupts a running turn. Every session it creates is deleted at the end.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge } from '../src/bridge.js'
import { resolveConfig } from '../src/config.js'
import { OpencodeClient, runEventLoop } from '../src/opencode.js'
import { fakeSlack, sleep } from '../tests/_util.mjs'

const [providerID, id] = (process.argv[2] ?? 'opencode-go/deepseek-v4.1-flash').split('/')
const dir = mkdtempSync(join(tmpdir(), 'ocs-live-'))
const logger = { info: (m) => console.log('  [info] ' + m), warn: (m) => console.log('  [warn] ' + m), error: (m) => console.log('  [error] ' + m) }
const config = resolveConfig({
  cwd: dir,
  allowedUserIds: ['UHUMAN'],
  model: { providerID, id },
  permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
  stateFile: join(dir, 'state.json'),
  interactiveTimeoutMs: 120000,
})
const slack = fakeSlack()
const opencode = new OpencodeClient(config.opencode)
const bridge = createBridge({ config, slack, opencode, logger })
const abort = new AbortController()
let chain = Promise.resolve()
const loop = runEventLoop({
  client: opencode,
  onEvent: (event) => { chain = chain.then(() => bridge.handleOpencodeEvent(event)).catch((e) => logger.warn(e.message)) },
  signal: abort.signal,
  logger,
})

let n = 0
const dm = (text, threadTs) => {
  const ts = String(Math.floor(Date.now() / 1000)) + '.' + String(++n).padStart(6, '0')
  return { type: 'message', channel: 'D1', channel_type: 'im', user: 'UHUMAN', ts, text, ...(threadTs ? { thread_ts: threadTs } : {}) }
}

async function until(label, fn, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + label)
    await sleep(250)
  }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''))
}

try {
  await bridge.identify()
  await sleep(500) // let the event stream connect

  // 1. plain reply
  const a = dm('Reply with exactly one word: PONG')
  await bridge.handleEvent(a)
  const replyA = await until('reply A', () => slack.posts.find((p) => p.threadTs === a.ts && p.blocks === undefined))
  check('reply comes back in the DM thread', /PONG/.test(replyA.text), JSON.stringify(replyA.text))
  check('done reaction swapped in', slack.reactions.some((r) => r.ts === a.ts && r.name === 'white_check_mark'))

  // 2. permission prompt → Allow once
  const b = dm('Use your bash tool to run exactly this command: echo hello-from-slack — then tell me its output.')
  await bridge.handleEvent(b)
  const prompt = await until('permission prompt', () => slack.posts.find((p) => p.threadTs === b.ts && Array.isArray(p.blocks)))
  check('permission prompt posted with buttons', prompt.blocks.some((blk) => blk.type === 'actions'), prompt.blocks[0].text.text.replace(/\n/g, ' ⏎ '))
  const allow = prompt.blocks.flatMap((blk) => blk.elements ?? []).find((e) => e.action_id === 'ocs_perm_once')
  await bridge.handleInteractive({ type: 'block_actions', user: { id: 'UHUMAN' }, actions: [{ action_id: 'ocs_perm_once', value: allow.value }] })
  check('prompt rewritten after the click', slack.updates.some((u) => u.ts === prompt.ts && /Allowed once/.test(u.text)))
  const replyB = await until('reply B', () => slack.posts.find((p) => p.threadTs === b.ts && p.blocks === undefined && p !== prompt))
  check('command ran after approval', /hello-from-slack/.test(replyB.text), JSON.stringify(replyB.text.slice(0, 200)))

  // 3. !stop interrupts a running turn
  const c = dm('Use your bash tool to run exactly: sleep 120 — and only then reply DONE.')
  await bridge.handleEvent(c)
  const prompt2 = await until('permission prompt 2', () => slack.posts.find((p) => p.threadTs === c.ts && Array.isArray(p.blocks)))
  const allow2 = prompt2.blocks.flatMap((blk) => blk.elements ?? []).find((e) => e.action_id === 'ocs_perm_once')
  await bridge.handleInteractive({ type: 'block_actions', user: { id: 'UHUMAN' }, actions: [{ action_id: 'ocs_perm_once', value: allow2.value }] })
  await sleep(4000)
  await bridge.handleEvent(dm('!stop', c.ts))
  const stopped = await until('stopped', () => slack.posts.find((p) => p.threadTs === c.ts && /^Stopped/.test(p.text)), 60000)
  check('!stop interrupted the turn', stopped !== undefined, stopped.text)
} catch (error) {
  check('smoke run', false, error.message)
} finally {
  abort.abort()
  await Promise.race([loop, sleep(2000)])
  bridge.dispose()
  // Clean up: delete every session this run created.
  const state = bridge._store
  for (const threadTs of [...slack.posts.map((p) => p.threadTs)]) {
    const entry = state.get('D1:' + threadTs)
    if (entry === undefined) continue
    try { await opencode.request('DELETE', '/api/session/' + entry.sessionId) } catch { /* already gone */ }
    state.unbind('D1:' + threadTs)
  }
  rmSync(dir, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok).length
  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed')
  process.exit(failed > 0 ? 1 : 0)
}
