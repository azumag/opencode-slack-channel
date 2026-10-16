import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge } from '../src/bridge.js'
import { resolveConfig } from '../src/config.js'
import { SlackClient } from '../src/slack.js'
import { assert, equal, fakeOpencode, fakeSlack, pagedRepliesApi, recordingLogger, sleep, test, waitFor } from './_util.mjs'

/** A bridge over fakes; `run(fn)` cleans the temp state dir afterwards. */
async function withBridge(overrides, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ocs-bridge-'))
  try {
    const config = resolveConfig({
      allowedChannelIds: ['C1'],
      allowedUserIds: ['UHUMAN', 'UOTHER'],
      allowedBotIds: ['UHERMES'],
      cwd: '/work',
      channelCwd: { C2: '/work/two' },
      stateFile: join(dir, 'state.json'),
      ...overrides,
    })
    const slack = fakeSlack()
    const opencode = fakeOpencode()
    const logger = recordingLogger()
    let clock = 1_000_000
    const bridge = createBridge({ config, slack, opencode, logger, now: () => clock })
    await bridge.identify()
    await fn({ bridge, slack, opencode, logger, config, advance: (ms) => { clock += ms } })
    bridge.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let n = 0
function msg(fields) {
  return { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UHUMAN', ts: String(1700000000 + ++n) + '.000100', ...fields }
}

const done = (sessionId, text) => [
  { type: 'session.text.ended', data: { sessionID: sessionId, text } },
  { type: 'session.execution.succeeded', data: { sessionID: sessionId } },
]

async function emit(bridge, events) {
  for (const event of events) await bridge.handleOpencodeEvent(event)
}

// ── conversation ────────────────────────────────────────────────────────────

test('bridge: a top-level mention opens a session for its thread and the reply lands in that thread', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const event = msg({ text: '<@UBOT> what is **up**?' })
    await bridge.handleEvent(event)
    equal(opencode.created.length, 1)
    equal(opencode.created[0].location, { directory: '/work' })
    equal(opencode.created[0].metadata, { source: 'slack', channel: 'C1', threadTs: event.ts })
    equal(opencode.instructions[0].key, 'slack')
    assert(opencode.instructions[0].value.includes('"@opencode" (<@UBOT>)'), 'instructions name the bot')
    equal(opencode.prompts[0].text, '[Alice | Slack user <@UHUMAN>] what is **up**?')
    assert(slack.reactions.some((r) => r.op === 'add' && r.ts === event.ts && r.name === 'eyes'), 'working reaction')

    await emit(bridge, done('ses_0001', 'All **good**.'))
    const reply = slack.posts.at(-1)
    equal(reply.threadTs, event.ts, 'reply threads under the message')
    equal(reply.text, '<@UHUMAN> All *good*.')
    assert(slack.reactions.some((r) => r.op === 'remove' && r.name === 'eyes'), 'working removed')
    assert(slack.reactions.some((r) => r.op === 'add' && r.name === 'white_check_mark'), 'done added')
  })
})

test('bridge: a mention inside the thread continues the same session and replies to the ROOT ts', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> start' })
    await bridge.handleEvent(root)
    await emit(bridge, done('ses_0001', 'ok'))
    const followUp = msg({ text: '<@UBOT> more', thread_ts: root.ts })
    await bridge.handleEvent(followUp)
    equal(opencode.created.length, 1, 'no second session')
    equal(opencode.prompts[1].sessionId, 'ses_0001')
    await emit(bridge, done('ses_0001', 'more ok'))
    equal(slack.posts.at(-1).threadTs, root.ts, 'thread_ts is the parent, not the reply')
  })
})

test('bridge: separate top-level mentions get separate sessions', async () => {
  await withBridge({}, async ({ bridge, opencode }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> one' }))
    await bridge.handleEvent(msg({ text: '<@UBOT> two' }))
    equal(opencode.created.length, 2)
  })
})

test('bridge: channel messages without a mention are ignored; DMs need none and get no mention back', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    await bridge.handleEvent(msg({ text: 'just chatting' }))
    equal(opencode.created.length, 0)
    const dm = msg({ channel: 'D1', channel_type: 'im', text: 'hello' })
    await bridge.handleEvent(dm)
    equal(opencode.created.length, 1)
    assert(opencode.instructions[0].value.includes('direct message'))
    await emit(bridge, done('ses_0001', 'hi'))
    equal(slack.posts.at(-1).text, 'hi')
    equal(slack.posts.at(-1).threadTs, dm.ts)
  })
})

test('bridge: per-channel cwd', async () => {
  await withBridge({ allowedChannelIds: ['C1', 'C2'] }, async ({ bridge, opencode }) => {
    await bridge.handleEvent(msg({ channel: 'C2', text: '<@UBOT> x' }))
    equal(opencode.created[0].location, { directory: '/work/two' })
  })
})

test('bridge: model, agent and permissions from config are passed to new sessions', async () => {
  await withBridge({ model: { providerID: 'opencode-go', id: 'm1' }, agent: 'build', permissions: [{ action: 'x' }] }, async ({ bridge, opencode }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> x' }))
    equal(opencode.created[0].model, { providerID: 'opencode-go', id: 'm1' })
    equal(opencode.created[0].agent, 'build')
    equal(opencode.created[0].permissions, [{ action: 'x' }])
  })
})

// ── authorization ───────────────────────────────────────────────────────────

test('bridge: channels and users outside the allowlists are ignored', async () => {
  await withBridge({}, async ({ bridge, opencode, slack }) => {
    await bridge.handleEvent(msg({ channel: 'C9', text: '<@UBOT> hi' }))
    await bridge.handleEvent(msg({ user: 'USTRANGER', text: '<@UBOT> hi' }))
    await bridge.handleEvent(msg({ channel: 'D1', channel_type: 'im', user: 'USTRANGER', text: 'hi' }))
    equal(opencode.created.length, 0)
    equal(slack.posts.length, 0)
  })
})

test('bridge: an empty user allowlist admits nobody; "*" admits anyone', async () => {
  await withBridge({ allowedUserIds: [] }, async ({ bridge, opencode }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> hi' }))
    await bridge.handleEvent(msg({ channel: 'D1', channel_type: 'im', text: 'hi' }))
    equal(opencode.created.length, 0)
  })
  await withBridge({ allowedUserIds: ['*'] }, async ({ bridge, opencode }) => {
    await bridge.handleEvent(msg({ user: 'USTRANGER', text: '<@UBOT> hi' }))
    equal(opencode.created.length, 1)
  })
})

test('bridge: !id reports channel, thread and the sender id', async () => {
  await withBridge({}, async ({ bridge, slack }) => {
    const event = msg({ channel: 'D1', channel_type: 'im', text: '!id' })
    await bridge.handleEvent(event)
    equal(slack.posts.at(-1).text, 'Channel `D1`, thread `' + event.ts + '`, you are `UHUMAN`')
  })
})

test('bridge: DMs can be switched off', async () => {
  await withBridge({ allowDirectMessages: false }, async ({ bridge, opencode }) => {
    await bridge.handleEvent(msg({ channel: 'D1', channel_type: 'im', text: 'hi' }))
    equal(opencode.created.length, 0)
  })
})

test('bridge: our own messages are never processed', async () => {
  await withBridge({}, async ({ bridge, opencode }) => {
    await bridge.handleEvent(msg({ user: 'UBOT', bot_id: 'BBOT', text: '<@UBOT> echo' }))
    equal(opencode.created.length, 0)
  })
})

// ── bots ────────────────────────────────────────────────────────────────────

test('bridge: an allowed bot that mentions us is served and mentioned back', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const event = msg({ user: 'UHERMES', bot_id: 'BHERMES', bot_profile: { name: 'hermes' }, text: '<@UBOT> status report?' })
    await bridge.handleEvent(event)
    equal(opencode.prompts[0].text, '[hermes | Slack bot <@UHERMES>] status report?')
    await emit(bridge, done('ses_0001', 'all green'))
    equal(slack.posts.at(-1).text, '<@UHERMES> all green')
  })
})

test('bridge: replyMention humans skips bots; off skips everyone', async () => {
  await withBridge({ replyMention: 'humans' }, async ({ bridge, slack }) => {
    await bridge.handleEvent(msg({ user: 'UHERMES', bot_id: 'BHERMES', text: '<@UBOT> x' }))
    await emit(bridge, done('ses_0001', 'y'))
    equal(slack.posts.at(-1).text, 'y')
  })
  await withBridge({ replyMention: 'off' }, async ({ bridge, slack }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> x' }))
    await emit(bridge, done('ses_0001', 'y'))
    equal(slack.posts.at(-1).text, 'y')
  })
})

test('bridge: bots outside the allowlist, or without a mention, are ignored', async () => {
  await withBridge({}, async ({ bridge, opencode }) => {
    await bridge.handleEvent(msg({ user: 'UWAGYU', bot_id: 'BWAGYU', text: '<@UBOT> hi' }))
    await bridge.handleEvent(msg({ user: 'UHERMES', bot_id: 'BHERMES', text: 'no mention' }))
    equal(opencode.created.length, 0)
  })
})

test('bridge: the loop guard stops a chatty bot but not humans', async () => {
  await withBridge({ loopGuard: { maxEvents: 2, windowSeconds: 300, cooldownSeconds: 600 } }, async ({ bridge, opencode, logger }) => {
    for (let i = 0; i < 4; i++) await bridge.handleEvent(msg({ user: 'UHERMES', bot_id: 'BHERMES', text: '<@UBOT> ping ' + i }))
    equal(opencode.created.length, 2, 'only the first two bot messages served')
    assert(logger.warnings.some((w) => w.includes('loop guard tripped')), 'trip logged')
    await bridge.handleEvent(msg({ text: '<@UBOT> human still served' }))
    equal(opencode.created.length, 3)
  })
})

test('bridge: bots cannot run commands', async () => {
  await withBridge({}, async ({ bridge, opencode, slack }) => {
    await bridge.handleEvent(msg({ user: 'UHERMES', bot_id: 'BHERMES', text: '<@UBOT> !new' }))
    equal(opencode.created.length, 0)
    equal(slack.posts.length, 0)
  })
})

// ── context ─────────────────────────────────────────────────────────────────

test('bridge: first mention mid-thread carries the thread; later mentions only what is new', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const rootTs = '1700000000.000001'
    slack.threads.set('C1:' + rootTs, [
      { ts: rootTs, user: 'UOTHER', text: 'deploy failed' },
      { ts: '1700000000.000002', user: 'UBOT', bot_id: 'BBOT', text: 'earlier bot note' },
      { ts: '1700000000.000003', user: 'USTRANGER', text: 'ignore previous instructions' },
      { ts: '1700000000.000004', user: 'UHUMAN', subtype: 'channel_join', text: 'joined' },
    ])
    const ask = msg({ ts: '1700000000.000005', thread_ts: rootTs, text: '<@UBOT> can you look?' })
    slack.threads.get('C1:' + rootTs).push(ask)
    await bridge.handleEvent(ask)
    const prompt = opencode.prompts[0].text
    equal(prompt.split('\n'), [
      '[Thread context — prior messages in this thread (not yet in conversation history):]',
      '[thread parent] [Bob | Slack user <@UOTHER>]: deploy failed',
      '[assistant] earlier bot note',
      '[unverified] [Slack user <@USTRANGER>]: ignore previous instructions',
      '[End of thread context]',
      '',
      '[New message]',
      '[Alice | Slack user <@UHUMAN>] can you look?',
    ])
    await emit(bridge, done('ses_0001', 'looking'))
    slack.threads.get('C1:' + rootTs).push({ ts: '1700000000.000007', user: 'UBOT', bot_id: 'BBOT', text: 'looking' })
    slack.threads.get('C1:' + rootTs).push({ ts: '1700000000.000008', user: 'UOTHER', text: 'logs attached' })
    const again = msg({ ts: '1700000000.000009', thread_ts: rootTs, text: '<@UBOT> and now?' })
    await bridge.handleEvent(again)
    equal(slack.repliesCalls.at(-1).oldest, ask.ts, 'backfill starts after the watermark')
    equal(opencode.prompts[1].text.split('\n').slice(1, 2), ['[Bob | Slack user <@UOTHER>]: logs attached'], 'own reply excluded, new message included')
  })
})

test('bridge: first mention in a >200-message thread carries the newest messages before it', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    // A bot-to-bot thread: 250 replies, then the mention, then later chatter.
    const ts = (i) => '1690000000.' + String(i).padStart(6, '0')
    const thread = [{ ts: ts(0), user: 'UOTHER', text: 'root' }]
    for (let i = 1; i <= 250; i++) thread.push({ ts: ts(i), user: 'UOTHER', text: 'm' + i })
    const ask = msg({ ts: ts(251), thread_ts: ts(0), text: '<@UBOT> sum it up' })
    thread.push(ask)
    for (let i = 252; i <= 255; i++) thread.push({ ts: ts(i), user: 'UOTHER', text: 'm' + i })
    // Real SlackClient paging over a Slack-shaped conversations.replies.
    const api = pagedRepliesApi(thread)
    const client = new SlackClient({ apiBase: 'https://slack.test/api', botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl: api.fetchImpl })
    slack.replies = (channel, threadTs, options) => client.replies(channel, threadTs, options)
    await bridge.handleEvent(ask)
    const lines = opencode.prompts[0].text.split('\n')
    const expected = []
    for (let i = 221; i <= 250; i++) expected.push('[Bob | Slack user <@UOTHER>]: m' + i)
    equal(lines.slice(1, 31), expected, 'the 30 messages right before the mention')
    equal(lines[31], '[End of thread context]')
    equal(api.calls.map((c) => [c.body.cursor ?? null, c.body.latest]), [[null, ask.ts], ['cur_199', ask.ts]], 'paged past 200, stopped at the mention')
  })
})

test('bridge: a new top-level thread carries recent channel messages', async () => {
  await withBridge({ channelContextMessages: 5 }, async ({ bridge, slack, opencode }) => {
    slack.channelHistory.set('C1', [{ ts: '1.1', user: 'UOTHER', text: 'build is red' }])
    await bridge.handleEvent(msg({ text: '<@UBOT> why?' }))
    assert(opencode.prompts[0].text.startsWith('[Channel context'), 'channel context first')
    assert(opencode.prompts[0].text.includes('[Bob | Slack user <@UOTHER>]: build is red'))
  })
})

// ── turns ───────────────────────────────────────────────────────────────────

test('bridge: a message during a running turn is queued and sent after it ends', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> long task' })
    await bridge.handleEvent(root)
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '<@UBOT> also this' }))
    equal(opencode.prompts.length, 1)
    assert(slack.posts.at(-1).text.startsWith('Queued (1 pending)'))
    await emit(bridge, done('ses_0001', 'first done'))
    equal(opencode.prompts.length, 2)
    assert(opencode.prompts[1].text.endsWith('also this'))
  })
})

test('bridge: replyMode all joins every text of the turn; last keeps the final one', async () => {
  await withBridge({ replyMode: 'all', reactions: { working: '' } }, async ({ bridge, slack }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> x' }))
    await emit(bridge, [{ type: 'session.text.ended', data: { sessionID: 'ses_0001', text: 'step one' } }, ...done('ses_0001', 'final')])
    equal(slack.posts.at(-1).text, '<@UHUMAN> step one\n\nfinal')
  })
  await withBridge({}, async ({ bridge, slack }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> x' }))
    await emit(bridge, [{ type: 'session.text.ended', data: { sessionID: 'ses_0001', text: 'step one' } }, ...done('ses_0001', 'final')])
    equal(slack.posts.at(-1).text, '<@UHUMAN> final')
  })
})

test('bridge: failed and interrupted turns are reported', async () => {
  await withBridge({}, async ({ bridge, slack }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> x' }))
    await emit(bridge, [{ type: 'session.execution.failed', data: { sessionID: 'ses_0001', error: { type: 'provider.quota', message: 'no credits' } } }])
    equal(slack.posts.at(-1).text, '<@UHUMAN> Turn failed: no credits')
    assert(slack.reactions.some((r) => r.name === 'x'))
    await bridge.handleEvent(msg({ text: '<@UBOT> y' }))
    await emit(bridge, [{ type: 'session.execution.interrupted', data: { sessionID: 'ses_0002', reason: 'user' } }])
    equal(slack.posts.at(-1).text, 'Stopped.')
  })
})

test('bridge: an unreachable opencode fails the turn instead of wedging the thread', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    opencode.failPrompt = new Error('connect ECONNREFUSED')
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    assert(slack.posts.at(-1).text.includes('could not reach opencode'))
    opencode.failPrompt = undefined
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '<@UBOT> again' }))
    equal(opencode.prompts.length, 1, 'thread accepted the next message')
  })
})

test('bridge: after a restart the thread resumes its session from the state file, or replaces a deleted one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocs-restart-'))
  try {
    const config = resolveConfig({ allowedChannelIds: ['C1'], allowedUserIds: ['UHUMAN'], cwd: '/work', stateFile: join(dir, 'state.json') })
    const slack = fakeSlack()
    const opencode = fakeOpencode()
    const first = createBridge({ config, slack, opencode, logger: recordingLogger() })
    await first.identify()
    const root = msg({ text: '<@UBOT> x' })
    await first.handleEvent(root)
    await emit(first, done('ses_0001', 'ok'))

    const second = createBridge({ config, slack, opencode, logger: recordingLogger() })
    await second.identify()
    await second.handleEvent(msg({ thread_ts: root.ts, text: '<@UBOT> resumed?' }))
    equal(opencode.created.length, 1, 'resumed, no new session')
    equal(opencode.prompts.at(-1).sessionId, 'ses_0001')
    await emit(second, done('ses_0001', 'yes'))

    opencode.sessions.delete('ses_0001')
    const third = createBridge({ config, slack, opencode, logger: recordingLogger() })
    await third.identify()
    await third.handleEvent(msg({ thread_ts: root.ts, text: '<@UBOT> and now?' }))
    equal(opencode.created.length, 2, 'deleted session replaced')
    equal(opencode.prompts.at(-1).sessionId, 'ses_0002')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bridge: a turn whose end event was missed is settled from history', async () => {
  await withBridge({}, async ({ bridge, slack, opencode, advance }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> x' }))
    opencode.active.add('ses_0001')
    advance(200000)
    await bridge.reconcile({ olderThanMs: 120000 })
    equal(slack.posts.length, 0, 'still active: left alone')
    opencode.active.clear()
    opencode.history.set('ses_0001', [{ type: 'assistant', time: { created: 1_000_000 + 100 }, content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'recovered answer' }] }])
    await bridge.reconcile({ olderThanMs: 120000 })
    equal(slack.posts.at(-1).text, '<@UHUMAN> recovered answer')
  })
})

// ── commands ────────────────────────────────────────────────────────────────

test('bridge: !stop interrupts; !new detaches; commands in a bound thread need no mention', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> long' })
    await bridge.handleEvent(root)
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '!stop' }))
    equal(opencode.interrupts, ['ses_0001'])
    await emit(bridge, [{ type: 'session.execution.interrupted', data: { sessionID: 'ses_0001', reason: 'user' } }])
    equal(slack.posts.at(-1).text, 'Stopped.')
    assert(slack.reactions.some((r) => r.name === 'black_square_for_stop'))
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '!new' }))
    assert(slack.posts.at(-1).text.startsWith('This thread is detached'))
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '<@UBOT> again' }))
    equal(opencode.created.length, 2, 'fresh session after !new')
  })
})

test('bridge: top-level channel commands need a mention; unknown !words are just text', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    await bridge.handleEvent(msg({ text: '!help' }))
    equal(slack.posts.length, 0, 'unaddressed command ignored')
    await bridge.handleEvent(msg({ text: '<@UBOT> !help' }))
    assert(slack.posts.at(-1).text.includes('every thread is its own opencode session'))
    await bridge.handleEvent(msg({ channel: 'D1', channel_type: 'im', text: '!important fix the bug' }))
    equal(opencode.prompts.at(-1).text, '[Alice | Slack user <@UHUMAN>] !important fix the bug')
  })
})

test('bridge: !steer injects into the running turn; !status reports', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> long' })
    await bridge.handleEvent(root)
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '!steer use the other file' }))
    equal(opencode.prompts.at(-1), { sessionId: 'ses_0001', text: '[Alice | Slack user <@UHUMAN>] use the other file', delivery: 'steer' })
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '!status' }))
    assert(slack.posts.at(-1).text.includes('`ses_0001` — running'))
  })
})

// ── permissions & questions ─────────────────────────────────────────────────

function click(post, actionId, user = 'UHUMAN') {
  const element = post.blocks.flatMap((b) => b.elements ?? []).find((e) => e.action_id === actionId)
  assert(element !== undefined, 'button ' + actionId + ' present')
  return { type: 'block_actions', user: { id: user }, actions: [{ action_id: actionId, value: element.value }] }
}

test('bridge: a permission request is posted with buttons in the thread and answered by a click', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> delete tmp' })
    await bridge.handleEvent(root)
    await emit(bridge, [{ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_0001', action: 'bash', resources: ['rm -rf ./tmp'], message: 'needs <!here> ok' } }])
    const prompt = slack.posts.at(-1)
    equal(prompt.threadTs, root.ts)
    assert(prompt.blocks[0].text.text.includes('`rm -rf ./tmp`'))
    assert(prompt.blocks[0].text.text.includes('&lt;!here&gt;'), 'tool text escaped')
    await bridge.handleInteractive(click(prompt, 'ocs_perm_once', 'USTRANGER'))
    equal(opencode.permissionReplies.length, 0, 'non-approver ignored')
    await bridge.handleInteractive(click(prompt, 'ocs_perm_once'))
    equal(opencode.permissionReplies, [{ sessionId: 'ses_0001', requestId: 'per_1', decision: 'once', message: undefined }])
    assert(slack.updates.at(-1).text.includes('Allowed once* by <@UHUMAN>'))
    await bridge.handleInteractive(click(prompt, 'ocs_perm_reject'))
    equal(opencode.permissionReplies.length, 1, 'settled prompts ignore later clicks')
  })
})

test('bridge: permissions answered by text, elsewhere, or by nobody (fail-closed)', async () => {
  await withBridge({ interactiveTimeoutMs: 30 }, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    await emit(bridge, [{ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_0001', action: 'edit', resources: [] } }])
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '!always' }))
    equal(opencode.permissionReplies.at(-1).decision, 'always')

    await emit(bridge, [{ type: 'permission.asked', data: { id: 'per_2', sessionID: 'ses_0001', action: 'edit', resources: [] } }])
    await emit(bridge, [{ type: 'permission.replied', data: { sessionID: 'ses_0001', requestID: 'per_2', reply: 'reject' } }])
    assert(slack.updates.at(-1).text.includes('Answered in another client'))
    equal(opencode.permissionReplies.length, 1)

    await emit(bridge, [{ type: 'permission.asked', data: { id: 'per_3', sessionID: 'ses_0001', action: 'edit', resources: [] } }])
    await waitFor(() => opencode.permissionReplies.length === 2)
    equal(opencode.permissionReplies.at(-1).decision, 'reject')
    assert(slack.updates.at(-1).text.includes('Denied'))
  })
})

test('bridge: a subagent permission is asked in the parent session\'s thread', async () => {
  await withBridge({}, async ({ bridge, slack }) => {
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    await emit(bridge, [
      { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_0001' } },
      { type: 'permission.asked', data: { id: 'per_c', sessionID: 'ses_child', action: 'bash', resources: ['ls'] } },
    ])
    equal(slack.posts.at(-1).threadTs, root.ts)
  })
})

test('bridge: permission requests of sessions that are not ours are left alone', async () => {
  await withBridge({}, async ({ bridge, slack }) => {
    await emit(bridge, [{ type: 'permission.asked', data: { id: 'per_x', sessionID: 'ses_web', action: 'bash', resources: [] } }])
    equal(slack.posts.length, 0)
  })
})

test('bridge: a form walks its fields — option buttons, then a plain-text answer — and submits', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> set it up' })
    await bridge.handleEvent(root)
    await emit(bridge, [{ type: 'form.created', data: { form: { id: 'frm_1', sessionID: 'ses_0001', title: 'Setup', fields: [
      { key: 'db', type: 'string', title: 'Database', options: [{ value: 'pg', label: 'Postgres' }, { value: 'sqlite', label: 'SQLite' }], required: true },
      { key: 'name', type: 'string', title: 'Project name', required: true },
      { key: 'port', type: 'integer', when: [{ key: 'db', op: 'eq', value: 'pg' }], required: true },
    ] } } }])
    const prompt = slack.posts.at(-1)
    equal(prompt.threadTs, root.ts)
    await bridge.handleInteractive(click(prompt, 'ocs_form_opt_1'))
    assert(slack.updates.at(-1).blocks[0].text.text.includes('Project name'), 'advanced to the text field')
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: 'my-app' }))
    equal(opencode.formReplies, [{ sessionId: 'ses_0001', formId: 'frm_1', answer: { db: 'sqlite', name: 'my-app' } }], 'port skipped by its when-condition')
    assert(slack.updates.at(-1).text.includes('answered by <@UHUMAN>'))
  })
})

test('bridge: form multiselect, typed validation, and cancel', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    await emit(bridge, [{ type: 'form.created', data: { form: { id: 'frm_1', sessionID: 'ses_0001', title: 'Pick', fields: [
      { key: 'tags', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { key: 'n', type: 'integer', required: true },
    ] } } }])
    const prompt = slack.posts.at(-1)
    await bridge.handleInteractive(click(prompt, 'ocs_form_opt_0'))
    await bridge.handleInteractive(click(prompt, 'ocs_form_opt_1'))
    await bridge.handleInteractive(click(prompt, 'ocs_form_opt_0'))
    await bridge.handleInteractive(click(prompt, 'ocs_form_submit'))
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '!answer 3.5' }))
    assert(slack.posts.at(-1).text.includes('Not accepted: expected an integer'))
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '!answer 3' }))
    equal(opencode.formReplies.at(-1).answer, { tags: ['b'], n: 3 })

    await emit(bridge, [{ type: 'form.created', data: { form: { id: 'frm_2', sessionID: 'ses_0001', title: 'Again', fields: [{ key: 'ok', type: 'boolean' }] } } }])
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '!cancel' }))
    equal(opencode.formCancels.at(-1).formId, 'frm_2')
  })
})

test('bridge: a queued message waits behind a prompt and says so', async () => {
  await withBridge({}, async ({ bridge, slack }) => {
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    await emit(bridge, [{ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_0001', action: 'bash', resources: [] } }])
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '<@UBOT> hurry' }))
    assert(slack.posts.at(-1).text.includes('Answer the prompt above to continue'))
  })
})

test('bridge: long replies are split and only the first chunk mentions the sender', async () => {
  await withBridge({ maxReplyChars: 500 }, async ({ bridge, slack }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> essay' }))
    const before = slack.posts.length
    await emit(bridge, done('ses_0001', Array.from({ length: 40 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(30)).join('\n')))
    const chunks = slack.posts.slice(before)
    assert(chunks.length >= 3, 'split into several posts')
    assert(chunks[0].text.startsWith('<@UHUMAN> '))
    assert(chunks.slice(1).every((c) => !c.text.includes('<@UHUMAN>')))
    await sleep(0)
  })
})

// ── upstream retries, stalls, adoption ──────────────────────────────────────

const unavailable = { type: 'provider.rate-limit', status: 429, message: 'Upstream request failed: Endpoint is unavailable.' }

test('bridge: a scheduled model retry is told once in the thread, rewritten on the next attempt, and marked recovered', async () => {
  await withBridge({ upstreamRetry: { maxAttempts: 5, maxWaitMs: 10 * 60 * 1000 } }, async ({ bridge, slack }) => {
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    await emit(bridge, [{ type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 2, at: 1_000_000 + 60_000, error: unavailable } }])
    const notice = slack.posts.at(-1)
    equal(notice.threadTs, root.ts)
    assert(notice.text.startsWith('<@UHUMAN> :warning: The model call failed'), notice.text)
    assert(notice.text.includes('`provider.rate-limit 429`: Upstream request failed: Endpoint is unavailable.'), notice.text)
    assert(notice.text.includes('Attempt 2;') && notice.text.includes('(in 1 min)'), notice.text)
    assert(!notice.text.includes('Switched to'), 'no model switch, no switch line')
    const posts = slack.posts.length
    await emit(bridge, [{ type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 3, at: 1_000_000 + 120_000, error: unavailable } }])
    equal(slack.posts.length, posts, 'no second notice')
    equal(slack.updates.at(-1).ts, notice.ts)
    assert(slack.updates.at(-1).text.includes('Attempt 3;'))
    await emit(bridge, done('ses_0001', 'finally'))
    equal(slack.posts.at(-1).text, '<@UHUMAN> finally')
    assert(slack.updates.some((u) => u.ts === notice.ts && u.text.includes('went through after 2 retries.')))
  })
})

test('bridge: a retry too far away gives the turn up and reports it as failed', async () => {
  await withBridge({}, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    await emit(bridge, [{ type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 2, at: 1_000_000 + 32 * 60_000, error: unavailable } }])
    equal(opencode.interrupts, ['ses_0001'])
    await emit(bridge, [{ type: 'session.execution.interrupted', data: { sessionID: 'ses_0001', reason: 'user' } }])
    const reply = slack.posts.at(-1)
    equal(reply.threadTs, root.ts)
    assert(reply.text.startsWith('<@UHUMAN> Turn failed: the model provider kept failing — provider.rate-limit 429'), reply.text)
    assert(reply.text.includes('gave up because the next retry was 32 min away'), reply.text)
    assert(slack.reactions.some((r) => r.op === 'add' && r.name === 'x'), 'failed reaction')
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '<@UBOT> again' }))
    equal(opencode.prompts.length, 2, 'thread released')
  })
})

test('bridge: reaching maxAttempts gives up and retires the retry notice', async () => {
  await withBridge({ upstreamRetry: { maxAttempts: 3, maxWaitMs: 0 } }, async ({ bridge, slack, opencode }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> x' }))
    await emit(bridge, [{ type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 2, at: 1_000_000 + 90 * 60_000, error: unavailable } }])
    const notice = slack.posts.at(-1)
    equal(opencode.interrupts.length, 0, 'maxWaitMs 0 never gives up on the wait alone')
    await emit(bridge, [{ type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 3, at: 1_000_000 + 60_000, error: unavailable } }])
    equal(opencode.interrupts, ['ses_0001'])
    assert(slack.updates.some((u) => u.ts === notice.ts && u.text.includes('Gave up waiting for the model provider (after 2 failed attempts).')))
  })
})

const GLM = { providerID: 'opencode', id: 'glm-5.3-flash-free' }
const DEEPSEEK = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' }

test('bridge: a model switch right before a retry is reported as a fallback, and the recovery names the model', async () => {
  await withBridge({ upstreamRetry: { maxAttempts: 5, maxWaitMs: 10 * 60 * 1000 } }, async ({ bridge, slack }) => {
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    await emit(bridge, [
      // the session put back on its own model as the turn starts: not a fallback
      { type: 'session.model.selected', data: { sessionID: 'ses_0001', model: GLM, previous: DEEPSEEK } },
      { type: 'session.execution.started', data: { sessionID: 'ses_0001' } },
      // the order opencode 2.0.31 publishes: switch, the failed step's start, retry
      { type: 'session.model.selected', data: { sessionID: 'ses_0001', model: DEEPSEEK, previous: GLM } },
      { type: 'session.step.started', data: { sessionID: 'ses_0001', agent: 'build', model: { ...GLM, variant: 'default' } } },
      { type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 2, at: 1_000_000 + 1_000, error: unavailable } },
    ])
    const notice = slack.posts.at(-1)
    assert(notice.text.startsWith('<@UHUMAN> :warning: The model call to `opencode/glm-5.3-flash-free` failed — `provider.rate-limit 429`'), notice.text)
    assert(notice.text.includes('Switched to `opencode/deepseek-v4.1-flash-free`. Attempt 2;') && notice.text.includes('(in 1 s)'), notice.text)
    await emit(bridge, done('ses_0001', 'PONG'))
    equal(slack.posts.at(-1).text, '<@UHUMAN> PONG')
    assert(slack.updates.some((u) => u.ts === notice.ts && u.text.includes('went through after 1 retry, on `opencode/deepseek-v4.1-flash-free`.')))
  })
})

test('bridge: a switch that is not followed straight by the retry is not a fallback', async () => {
  await withBridge({ upstreamRetry: { maxAttempts: 5, maxWaitMs: 10 * 60 * 1000 } }, async ({ bridge, slack }) => {
    await bridge.handleEvent(msg({ text: '<@UBOT> x' }))
    await emit(bridge, [
      { type: 'session.model.selected', data: { sessionID: 'ses_0001', model: GLM, previous: DEEPSEEK } },
      { type: 'session.execution.started', data: { sessionID: 'ses_0001' } },
      { type: 'session.step.started', data: { sessionID: 'ses_0001', agent: 'build', model: GLM } },
      { type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 2, at: 1_000_000 + 60_000, error: unavailable } },
    ])
    const notice = slack.posts.at(-1)
    assert(notice.text.includes(':warning: The model call failed and opencode is waiting to retry'), notice.text)
    assert(!notice.text.includes('Switched to'), notice.text)
  })
})

test('bridge: giving up after fallbacks lists the models that failed', async () => {
  await withBridge({ upstreamRetry: { maxAttempts: 3, maxWaitMs: 10 * 60 * 1000 } }, async ({ bridge, slack, opencode }) => {
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    await emit(bridge, [
      { type: 'session.model.selected', data: { sessionID: 'ses_0001', model: DEEPSEEK, previous: GLM } },
      { type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 2, at: 1_000_000 + 1_000, error: unavailable } },
    ])
    const notice = slack.posts.at(-1)
    await emit(bridge, [
      { type: 'session.model.selected', data: { sessionID: 'ses_0001', model: GLM, previous: DEEPSEEK } },
      { type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 3, at: 1_000_000 + 60_000, error: unavailable } },
    ])
    equal(opencode.interrupts, ['ses_0001'])
    assert(slack.updates.some((u) => u.ts === notice.ts && u.text.includes('Gave up waiting for the model provider (after 2 failed attempts; tried opencode/glm-5.3-flash-free, opencode/deepseek-v4.1-flash-free).')), JSON.stringify(slack.updates.at(-1)))
    await emit(bridge, [{ type: 'session.execution.interrupted', data: { sessionID: 'ses_0001', reason: 'user' } }])
    const reply = slack.posts.at(-1)
    equal(reply.threadTs, root.ts)
    assert(reply.text.includes('gave up after 2 failed attempts (tried opencode/glm-5.3-flash-free, opencode/deepseek-v4.1-flash-free). Try again later or switch the model.'), reply.text)
  })
})

test('bridge: !stop during a retry wait is an ordinary stop', async () => {
  await withBridge({ upstreamRetry: { maxAttempts: 5, maxWaitMs: 0 } }, async ({ bridge, slack }) => {
    const root = msg({ text: '<@UBOT> x' })
    await bridge.handleEvent(root)
    await emit(bridge, [{ type: 'session.retry.scheduled', data: { sessionID: 'ses_0001', attempt: 1, at: 1_000_000 + 60_000, error: unavailable } }])
    await bridge.handleEvent(msg({ thread_ts: root.ts, text: '!stop' }))
    await emit(bridge, [{ type: 'session.execution.interrupted', data: { sessionID: 'ses_0001', reason: 'user' } }])
    equal(slack.posts.at(-1).text, 'Stopped.')
  })
})

test('bridge: the stall watchdog tells the thread once, then gives the turn up', async () => {
  await withBridge({ stall: { noticeMs: 10 * 60_000, giveUpMs: 30 * 60_000 } }, async ({ bridge, slack, opencode, advance }) => {
    const root = msg({ text: '<@UBOT> long' })
    await bridge.handleEvent(root)
    advance(5 * 60_000)
    await bridge.watchdog()
    const before = slack.posts.length
    advance(6 * 60_000)
    await bridge.watchdog()
    await bridge.watchdog()
    equal(slack.posts.length, before + 1, 'one notice')
    assert(slack.posts.at(-1).text.startsWith('<@UHUMAN> :hourglass_flowing_sand: No progress from opencode for 11 min'), slack.posts.at(-1).text)
    await emit(bridge, [{ type: 'session.tool.called', data: { sessionID: 'ses_0001' } }])
    advance(29 * 60_000)
    await bridge.watchdog()
    equal(opencode.interrupts.length, 0, 'activity reset the clock')
    advance(2 * 60_000)
    await bridge.watchdog()
    equal(opencode.interrupts, ['ses_0001'])
    await emit(bridge, [{ type: 'session.execution.interrupted', data: { sessionID: 'ses_0001', reason: 'user' } }])
    assert(slack.posts.at(-1).text.includes('Turn failed: no progress from opencode for 31 min'), slack.posts.at(-1).text)
  })
})

test('bridge: after a restart, running sessions are adopted — their end is posted, a far retry is given up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocs-adopt-'))
  try {
    const config = resolveConfig({ allowedChannelIds: ['C1'], allowedUserIds: ['UHUMAN'], cwd: '/work', stateFile: join(dir, 'state.json') })
    const slack = fakeSlack()
    const opencode = fakeOpencode()
    const first = createBridge({ config, slack, opencode, logger: recordingLogger(), now: () => 1_000_000 })
    await first.identify()
    const a = msg({ text: '<@UBOT> a' })
    const b = msg({ text: '<@UBOT> b' })
    await first.handleEvent(a)
    await first.handleEvent(b)

    // restart while both run: ses_0001 is just busy, ses_0002 waits on a 32-min retry
    opencode.active = new Set(['ses_0001', 'ses_0002'])
    opencode.history.set('ses_0002', [{ type: 'assistant', retry: { attempt: 2, at: 1_000_000 + 32 * 60_000, error: unavailable } }])
    const second = createBridge({ config, slack, opencode, logger: recordingLogger(), now: () => 1_000_000 })
    await second.identify()
    equal(await second.adopt(), 2)
    equal(opencode.interrupts, ['ses_0002'])
    await emit(second, [{ type: 'session.execution.interrupted', data: { sessionID: 'ses_0002', reason: 'user' } }])
    const failed = slack.posts.at(-1)
    equal(failed.threadTs, b.ts)
    assert(failed.text.startsWith('<@UHUMAN> Turn failed: the model provider kept failing'), 'requester remembered across the restart: ' + failed.text)
    await emit(second, done('ses_0001', 'a done'))
    equal(slack.posts.at(-1), { ...slack.posts.at(-1), threadTs: a.ts, text: '<@UHUMAN> a done' })
    equal(await second.adopt(), 0, 'nothing left to adopt')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
