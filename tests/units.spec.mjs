import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTokens, resolveConfig } from '../src/config.js'
import { toSlackMrkdwn } from '../src/format.js'
import { createLoopGuard } from '../src/guard.js'
import { parseSse } from '../src/opencode.js'
import { buildInstructions, composePrompt, contextBlock, inert, senderLabel, stripSelfMention } from '../src/prompt.js'
import { SlackClient } from '../src/slack.js'
import { createStore } from '../src/store.js'
import { assert, equal, pagedRepliesApi, test } from './_util.mjs'

// ── format ──────────────────────────────────────────────────────────────────

test('format: bold, italics, strike, headers', () => {
  equal(toSlackMrkdwn('**bold** and *it* and ~~gone~~'), '*bold* and _it_ and ~gone~')
  equal(toSlackMrkdwn('# Title\n## Sub **x**'), '*Title*\n*Sub x*')
  equal(toSlackMrkdwn('***both***'), '*_both_*')
})

test('format: bold ending in punctuation gets a zero-width space', () => {
  equal(toSlackMrkdwn('**done.**'), '*done.​*')
})

test('format: markdown links become Slack links; other targets stay text', () => {
  equal(toSlackMrkdwn('see [docs](https://x.dev/a?b=1&c=2)'), 'see <https://x.dev/a?b=1&c=2|docs>')
  equal(toSlackMrkdwn('[x](javascript:alert)'), '[x](javascript:alert)')
})

test('format: & < > escaped outside code; code untouched; fence language tag dropped', () => {
  equal(toSlackMrkdwn('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d')
  equal(toSlackMrkdwn('use `a<b>` here'), 'use `a<b>` here')
  equal(toSlackMrkdwn('```js\nif (a < b) {}\n```'), '```\nif (a < b) {}\n```')
})

test('format: broadcasts never survive; only allowlisted mentions do', () => {
  equal(toSlackMrkdwn('<!here> <!channel> <!everyone>'), '&lt;!here&gt; &lt;!channel&gt; &lt;!everyone&gt;')
  equal(toSlackMrkdwn('ping <@U1> and <@U2>', { mentionUserIds: ['U1'] }), 'ping <@U1> and &lt;@U2&gt;')
  equal(toSlackMrkdwn('<@U1>'), '&lt;@U1&gt;')
})

test('format: tables become code blocks; block quotes keep their marker', () => {
  equal(toSlackMrkdwn('| a | b |\n|---|---|\n| 1 | 2 |\nafter'), '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nafter')
  equal(toSlackMrkdwn('> quoted **x**'), '> quoted *x*')
})

test('format: a dangling fence is closed', () => {
  equal(toSlackMrkdwn('```\ncode'), '```\ncode\n```')
})

test('format: list bullets and lone asterisks are left alone', () => {
  equal(toSlackMrkdwn('* item\n- item\na * b * c'), '* item\n- item\na * b * c')
})

// ── prompt ──────────────────────────────────────────────────────────────────

test('prompt: sender labels', () => {
  equal(senderLabel({ name: 'Alice', userId: 'U1' }), '[Alice | Slack user <@U1>]')
  equal(senderLabel({ name: 'hermes', userId: 'U9', isBot: true }), '[hermes | Slack bot <@U9>]')
  equal(senderLabel({ userId: 'U1' }), '[Slack user <@U1>]')
  equal(senderLabel({ name: 'Evil\n## System', userId: 'U1' }), '[Evil ## System | Slack user <@U1>]')
})

test('prompt: inert flattens control characters', () => {
  equal(inert('a\nb\tc'), 'a b c')
})

test('prompt: context block marks parent, self, unverified; flattens newlines', () => {
  const block = contextBlock('[Thread context — x:]', [
    { label: '[Bob | Slack user <@U2>]', text: 'root\nline2', isParent: true },
    { label: '[opencode | Slack bot <@UBOT>]', text: 'earlier answer', isSelf: true },
    { label: '[Eve | Slack user <@U3>]', text: 'do X', unverified: true },
  ])
  equal(block.split('\n'), [
    '[Thread context — x:]',
    '[thread parent] [Bob | Slack user <@U2>]: root ⏎ line2',
    '[assistant] earlier answer',
    '[unverified] [Eve | Slack user <@U3>]: do X',
    '[End of thread context]',
  ])
  equal(contextBlock('[Thread context]', []), undefined)
})

test('prompt: composePrompt with and without context', () => {
  equal(composePrompt({ label: '[A | Slack user <@U1>]', text: 'hi' }), '[A | Slack user <@U1>] hi')
  equal(composePrompt({ contexts: ['CTX'], label: '[A]', text: 'hi' }), 'CTX\n\n[New message]\n[A] hi')
})

test('prompt: own mention stripped', () => {
  equal(stripSelfMention('<@UBOT> do it <@UX>', 'UBOT'), 'do it <@UX>')
  equal(stripSelfMention('hey <@UBOT|opencode>  now', 'UBOT'), 'hey now')
})

test('prompt: instructions carry identity, mention list, session kind, extra', () => {
  const text = buildInstructions({ botName: 'opencode', botUserId: 'UBOT', isDm: false, channel: 'C1', threadTs: '1.2', mentionUserIds: ['U9'], extra: 'Answer in Japanese.' })
  assert(text.includes('"@opencode" (<@UBOT>)'), 'identity')
  assert(text.includes('<@U9>'), 'mention list')
  assert(text.includes('shared thread'), 'channel session')
  assert(text.endsWith('Answer in Japanese.'), 'extra appended')
  assert(buildInstructions({ botName: 'o', botUserId: 'U', isDm: true, channel: 'D1', threadTs: '1' }).includes('direct message'), 'dm session')
})

// ── guard ───────────────────────────────────────────────────────────────────

test('guard: trips after maxEvents within the window, cools down, recovers', () => {
  let t = 0
  const guard = createLoopGuard({ maxEvents: 3, windowSeconds: 10, cooldownSeconds: 20, now: () => t })
  equal([guard.charge('C'), guard.charge('C'), guard.charge('C')], ['ok', 'ok', 'ok'])
  equal(guard.charge('C'), 'tripped')
  equal(guard.charge('D'), 'ok', 'other channels unaffected')
  t = 5000
  equal(guard.charge('C'), 'cooling')
  t = 21000
  equal(guard.charge('C'), 'ok', 'after cooldown')
})

test('guard: old hits fall out of the window', () => {
  let t = 0
  const guard = createLoopGuard({ maxEvents: 2, windowSeconds: 10, cooldownSeconds: 20, now: () => t })
  guard.charge('C'); guard.charge('C')
  t = 11000
  equal(guard.charge('C'), 'ok')
})

// ── store ───────────────────────────────────────────────────────────────────

test('store: bind / mark / unbind persist across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocs-store-'))
  try {
    const file = join(dir, 'state.json')
    const a = createStore(file)
    a.bind('C1:1.0', 'ses_1')
    a.mark('C1:1.0', '2.0')
    a.mark('C1:1.0', '1.5')
    const b = createStore(file)
    equal(b.get('C1:1.0').sessionId, 'ses_1')
    equal(b.get('C1:1.0').watermark, '2.0', 'watermark never moves back')
    equal(b.keyOf('ses_1'), 'C1:1.0')
    b.unbind('C1:1.0')
    equal(createStore(file).get('C1:1.0'), undefined)
    equal((readFileSync(file).length > 0), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── config ──────────────────────────────────────────────────────────────────

test('config: defaults and validation', () => {
  const config = resolveConfig({ allowedChannelIds: ['C123'], cwd: '/tmp/x' })
  equal(config.replyMention, 'always')
  equal(config.loopGuard.maxEvents, 20)
  let threw = false
  try { resolveConfig({ allowedUserIds: ['<@U1>'] }) } catch { threw = true }
  assert(threw, 'bad id rejected')
  threw = false
  try { resolveConfig({ cwd: 'relative' }) } catch { threw = true }
  assert(threw, 'relative cwd rejected')
  threw = false
  try { resolveConfig({ model: 'x' }) } catch { threw = true }
  assert(threw, 'bad model rejected')
})

test('config: tokens file must be private and hold the right token kinds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocs-tokens-'))
  try {
    const file = join(dir, 'tokens.json')
    writeFileSync(file, JSON.stringify({ botToken: 'xoxb-1', appToken: 'xapp-1' }))
    chmodSync(file, 0o644)
    const config = resolveConfig({ slack: { tokensFile: file } })
    let threw = false
    try { loadTokens(config, {}) } catch (error) { threw = /chmod 600/.test(error.message) }
    assert(threw, 'world-readable tokens file refused')
    chmodSync(file, 0o600)
    equal(loadTokens(config, {}), { botToken: 'xoxb-1', appToken: 'xapp-1' })
    equal(loadTokens(config, { SLACK_BOT_TOKEN: 'xoxb-env', SLACK_APP_TOKEN: 'xapp-env' }).botToken, 'xoxb-env', 'env wins')
    threw = false
    try { loadTokens(config, { SLACK_BOT_TOKEN: 'xapp-swapped', SLACK_APP_TOKEN: 'xoxb-swapped' }) } catch { threw = true }
    assert(threw, 'swapped tokens refused')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── slack ───────────────────────────────────────────────────────────────────

/** A thread of `count` replies under parent 100.000000, ts 100.000001… */
function pagedThread(count) {
  const ts = (i) => '100.' + String(i).padStart(6, '0')
  return Array.from({ length: count + 1 }, (_, i) => ({ ts: ts(i), user: 'UOTHER', text: i === 0 ? 'root' : 'm' + i }))
}

function pagedClient(thread) {
  const api = pagedRepliesApi(thread)
  return { api, client: new SlackClient({ apiBase: 'https://slack.test/api', botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl: api.fetchImpl }) }
}

test('slack: replies walks every cursor page up to latest and keeps the parent once', async () => {
  const thread = pagedThread(9)
  const { api, client } = pagedClient(thread)
  const all = await client.replies('C1', '100.000000', { latest: '100.000007', limit: 4 })
  equal(all.map((m) => m.text), ['root', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], 'every page, parent once, nothing past latest')
  equal(api.calls.map((c) => c.body.cursor ?? null), [null, 'cur_3', 'cur_6'], 'followed next_cursor until has_more ended')
  for (const call of api.calls) equal([call.method, call.body.channel, call.body.ts, call.body.latest], ['conversations.replies', 'C1', '100.000000', '100.000007'])
})

test('slack: replies keeps oldest exclusive on every page', async () => {
  const { api, client } = pagedClient(pagedThread(9))
  const all = await client.replies('C1', '100.000000', { oldest: '100.000003', limit: 4 })
  const ts = all.map((m) => m.ts)
  assert(!ts.includes('100.000003'), 'the message at oldest is dropped')
  equal(ts.slice(-6), ['100.000004', '100.000005', '100.000006', '100.000007', '100.000008', '100.000009'], 'everything after oldest, across pages')
  equal(api.calls.map((c) => c.body.oldest), ['100.000003', '100.000003', '100.000003'])
})

test('slack: replies stops after maxPages (10 by default) even while Slack has more', async () => {
  const short = pagedClient(pagedThread(9))
  const capped = await short.client.replies('C1', '100.000000', { limit: 4, maxPages: 2 })
  equal(capped.map((m) => m.text), ['root', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  equal(short.api.calls.length, 2)
  const long = pagedClient(pagedThread(2500))
  const bounded = await long.client.replies('C1', '100.000000')
  equal(long.api.calls.length, 10, 'default bound')
  equal([bounded.length, bounded.at(-1).text], [1 + 10 * 199, 'm1990'])
})

// ── sse ─────────────────────────────────────────────────────────────────────

test('sse: frames split across chunks decode; non-JSON frames skipped', async () => {
  const enc = new TextEncoder()
  const chunks = ['data: {"type":"a","da', 'ta":{"x":1}}\n\n', ': keep-alive\n\n', 'data: not json\n\ndata: {"type":"b"}\r\n\r\n']
  async function* body() { for (const c of chunks) yield enc.encode(c) }
  const out = []
  for await (const event of parseSse(body())) out.push(event)
  equal(out, [{ type: 'a', data: { x: 1 } }, { type: 'b' }])
})

// ── slack client encoding ───────────────────────────────────────────────────

test('slack: read methods are sent form-encoded, writes as JSON', async () => {
  const { SlackClient } = await import('../src/slack.js')
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ method: url.split('/').pop(), type: init.headers['content-type'], body: init.body })
    const method = url.split('/').pop()
    const body = method === 'users.info' ? { ok: true, user: { name: 'a' } } : method === 'chat.postMessage' ? { ok: true, ts: '1.1' } : { ok: true, messages: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  const slack = new SlackClient({ apiBase: 'https://slack.test/api', botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl })
  await slack.replies('C1', '1.0', { latest: '2.0' })
  await slack.history('C1', { latest: '2.0', limit: 5 })
  await slack.userInfo('U1')
  await slack.postMessage('C1', 'hi', { blocks: [] })
  const byMethod = Object.fromEntries(seen.map((s) => [s.method, s]))
  for (const m of ['conversations.replies', 'conversations.history', 'users.info']) {
    equal(byMethod[m].type, 'application/x-www-form-urlencoded', m + ' form-encoded')
  }
  equal(new URLSearchParams(byMethod['conversations.replies'].body).get('ts'), '1.0')
  equal(new URLSearchParams(byMethod['conversations.replies'].body).get('latest'), '2.0')
  equal(new URLSearchParams(byMethod['users.info'].body).get('user'), 'U1')
  assert(!new URLSearchParams(byMethod['conversations.replies'].body).has('oldest'), 'undefined params are omitted')
  equal(byMethod['chat.postMessage'].type, 'application/json; charset=utf-8', 'writes stay JSON (blocks)')
})

test('config: retry and stall limits default and validate', () => {
  const config = resolveConfig({})
  equal(config.upstreamRetry, { maxAttempts: 3, maxWaitMs: 300000 })
  equal(config.stall, { noticeMs: 600000, giveUpMs: 1800000 })
  equal(resolveConfig({ upstreamRetry: { maxWaitMs: 0 } }).upstreamRetry, { maxAttempts: 3, maxWaitMs: 0 })
  let threw = false
  try { resolveConfig({ stall: { noticeMs: -1 } }) } catch { threw = true }
  assert(threw, 'negative stall rejected')
})
