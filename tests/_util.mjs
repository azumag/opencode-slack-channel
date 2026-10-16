// Tiny dependency-free test harness (after dsh-slack-channel's): test(),
// assertions, waitFor, and in-memory fakes of the Slack and opencode clients.

let failures = 0
let runs = 0
const pending = []

export function test(name, fn) {
  runs++
  pending.push((async () => {
    try {
      await fn()
      process.stdout.write('  ok   ' + name + '\n')
    } catch (error) {
      failures++
      process.stdout.write('  FAIL ' + name + ': ' + (error?.stack ?? String(error)) + '\n')
    }
  })())
}

export async function summary() {
  await Promise.all(pending)
  process.stdout.write('\n' + (runs - failures) + '/' + runs + ' passed\n')
  process.exit(failures > 0 ? 1 : 0)
}

export function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed')
}

export function equal(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error((message ?? 'not equal') + ':\n    actual:   ' + a + '\n    expected: ' + b)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitFor(fn, timeoutMs = 2000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await sleep(stepMs)
  }
}

export const silentLogger = { info() {}, warn() {}, error() {} }

/** Recording logger: warnings are kept for assertions. */
export function recordingLogger() {
  const warnings = []
  return { warnings, info() {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) }
}

let tsCounter = 1000

/** Fake SlackClient: records every write; reads come from `threads` / `channelHistory`. */
export function fakeSlack({ self = { user_id: 'UBOT', bot_id: 'BBOT', user: 'opencode' } } = {}) {
  const fake = {
    posts: [],
    updates: [],
    reactions: [],
    repliesCalls: [],
    threads: new Map(),
    channelHistory: new Map(),
    users: new Map([['UHUMAN', { profile: { display_name: 'Alice' } }], ['UOTHER', { profile: { display_name: 'Bob' } }]]),
    async authTest() {
      return self
    },
    async postMessage(channel, text, options = {}) {
      const ts = String(++tsCounter) + '.000100'
      fake.posts.push({ channel, text, threadTs: options.threadTs, blocks: options.blocks, ts })
      return { channel, ts }
    },
    async updateMessage(channel, ts, text, options = {}) {
      fake.updates.push({ channel, ts, text, blocks: options.blocks })
      return { channel, ts }
    },
    async react(channel, ts, name) {
      fake.reactions.push({ op: 'add', channel, ts, name })
      return true
    },
    async unreact(channel, ts, name) {
      fake.reactions.push({ op: 'remove', channel, ts, name })
      return true
    },
    async replies(channel, threadTs, { oldest, latest } = {}) {
      fake.repliesCalls.push({ channel, threadTs, oldest, latest })
      return (fake.threads.get(channel + ':' + threadTs) ?? []).filter((m) => oldest === undefined || Number(m.ts) > Number(oldest))
    },
    async history(channel) {
      return [...(fake.channelHistory.get(channel) ?? [])].reverse()
    },
    async userInfo(userId) {
      const user = fake.users.get(userId)
      if (user === undefined) throw Object.assign(new Error('user_not_found'), { slackError: 'user_not_found' })
      return user
    },
  }
  return fake
}

/**
 * fetch stand-in for a real SlackClient that serves conversations.replies the
 * way Slack pages it: `thread[0]` is the parent and heads every page, replies
 * follow oldest first, at most `limit` messages per page (parent included),
 * then `has_more` + `response_metadata.next_cursor`. `oldest` / `latest` are
 * inclusive, as Slack's are. Every request lands in `calls`.
 */
export function pagedRepliesApi(thread) {
  const calls = []
  async function fetchImpl(url, init) {
    const method = url.slice(url.lastIndexOf('/') + 1)
    // Read methods go out form-encoded (Slack rejects JSON for them); form
    // values are strings, so the numeric ones are restored here.
    const isForm = String(init.headers?.['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')
    const body = isForm ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body)
    if (body.limit !== undefined) body.limit = Number(body.limit)
    calls.push({ method, body })
    if (method !== 'conversations.replies') return Response.json({ ok: false, error: 'unknown_method' })
    const [parent, ...rest] = thread
    const inRange = rest.filter((m) => (body.oldest === undefined || Number(m.ts) >= Number(body.oldest))
      && (body.latest === undefined || Number(m.ts) <= Number(body.latest)))
    const start = body.cursor === undefined ? 0 : Number(body.cursor.replace('cur_', ''))
    const end = start + body.limit - 1
    const hasMore = end < inRange.length
    return Response.json({
      ok: true,
      messages: [parent, ...inRange.slice(start, end)],
      has_more: hasMore,
      response_metadata: { next_cursor: hasMore ? 'cur_' + end : '' },
    })
  }
  return { calls, fetchImpl }
}

/** Fake OpencodeClient: records calls; tests emit events into the bridge themselves. */
export function fakeOpencode() {
  let n = 0
  const fake = {
    sessions: new Map(),
    created: [],
    instructions: [],
    prompts: [],
    interrupts: [],
    permissionReplies: [],
    formReplies: [],
    formCancels: [],
    active: new Set(),
    history: new Map(),
    failPrompt: undefined,
    async createSession(body) {
      const id = 'ses_' + String(++n).padStart(4, '0')
      const info = { id, ...body }
      fake.sessions.set(id, info)
      fake.created.push(body)
      return info
    },
    async getSession(id) {
      const info = fake.sessions.get(id)
      if (info === undefined) throw Object.assign(new Error('Session not found'), { status: 404 })
      return info
    },
    async putInstructions(sessionId, key, value) {
      fake.instructions.push({ sessionId, key, value })
    },
    async prompt(sessionId, text, options = {}) {
      if (fake.failPrompt !== undefined) throw fake.failPrompt
      fake.prompts.push({ sessionId, text, delivery: options.delivery })
      return { id: 'msg_' + fake.prompts.length }
    },
    async interrupt(sessionId) {
      fake.interrupts.push(sessionId)
      return { interrupted: true }
    },
    async replyPermission(sessionId, requestId, decision, message) {
      fake.permissionReplies.push({ sessionId, requestId, decision, message })
    },
    async replyForm(sessionId, formId, answer) {
      fake.formReplies.push({ sessionId, formId, answer })
    },
    async cancelForm(sessionId, formId, message) {
      fake.formCancels.push({ sessionId, formId, message })
    },
    async activeSessionIds() {
      return new Set(fake.active)
    },
    async messages(sessionId) {
      return fake.history.get(sessionId) ?? []
    },
  }
  return fake
}
