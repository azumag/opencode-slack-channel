// The bridge: Slack messages in, opencode v2 sessions out.
//
//   Slack message (mention or DM) → one opencode session per Slack thread
//     → POST /api/session/{id}/prompt
//   /api/event session.text.ended          → collected per turn
//   /api/event session.execution.{succeeded,failed,interrupted}
//                                          → reply posted in the thread
//   /api/event permission.asked / form.created → Slack prompt (interactions.js)
//
// Behaviour follows docs/SPEC.md §3: Hermes' conversation model (per-thread
// sessions, sender-attributed prompts, thread backfill since a watermark)
// on dsh-slack-channel's structure (queueing, commands, prompts with buttons),
// with channel AND user allowlists, a bot allowlist, and a bot loop guard.

import { toSlackMrkdwn } from './format.js'
import { createLoopGuard } from './guard.js'
import { createInteractions } from './interactions.js'
import { buildInstructions, composePrompt, contextBlock, senderLabel, stripSelfMention } from './prompt.js'
import { splitMessage } from './slack.js'
import { createStore, threadKey } from './store.js'

const HELP_TEXT = [
  'opencode in Slack. Mention me to start; every thread is its own opencode session.',
  'Commands (in a DM, in a thread I am working in, or after a mention):',
  '`!new` — forget this thread\'s session; the next message starts a fresh one',
  '`!stop` — interrupt the running turn and clear the queue',
  '`!steer <text>` — add an instruction to the running turn',
  '`!status` — session, model, and what is running',
  '`!allow` / `!always` / `!deny` — answer a permission prompt',
  '`!answer <text>` / `!cancel` — answer or cancel a question',
  '`!id` — show this channel id and your user id',
].join('\n')

const COMMANDS = new Set(['help', 'start', 'id', 'new', 'stop', 'steer', 'status', 'allow', 'always', 'deny', 'answer', 'cancel'])

/** Message subtypes that carry a real message; everything else is a trace. */
const MESSAGE_SUBTYPES = new Set([undefined, 'bot_message', 'file_share', 'thread_broadcast'])

export function createBridge({ config, slack, opencode, logger, now = () => Date.now() }) {
  const store = createStore(config.stateFile, { logger })
  const guard = createLoopGuard(config.loopGuard)
  const mrkdwnOptions = { mentionUserIds: config.mentionUserIds }

  /** sessionId → live record; key → record. */
  const records = new Map()
  const recordsByKey = new Map()
  /** child session id → parent session id (subagents), or null when not ours. */
  const parents = new Map()
  const userNames = new Map()
  let userLookups = true
  const seen = new Set()
  const warned = new Set()

  let self = { userId: undefined, botId: undefined, name: undefined }

  const interactions = createInteractions({ config, logger, slack, opencode, isApprover })

  function errorText(error) {
    return error?.message ?? String(error)
  }

  function warnOnce(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    logger.warn(message)
  }

  // ── identity & authorization ─────────────────────────────────────────────

  /** Resolve our own ids (auth.test). Until then every bot message is dropped. */
  async function identify(signal) {
    const me = await slack.authTest(signal)
    if (!me.user_id) throw new Error('auth.test returned no user_id')
    self = { userId: me.user_id, botId: me.bot_id, name: me.user }
    logger.info('slack identity: @' + me.user + ' (' + me.user_id + ', bot ' + me.bot_id + ')')
    return self
  }

  function isSelf(event) {
    if (self.userId === undefined) return Boolean(event.bot_id) || event.subtype === 'bot_message'
    return event.user === self.userId || (event.bot_id !== undefined && event.bot_id === self.botId)
  }

  function isBotEvent(event) {
    return Boolean(event.bot_id) || event.subtype === 'bot_message' || event.bot_profile !== undefined
  }

  function channelAllowed(channel, isDm) {
    if (isDm) return config.allowDirectMessages === true
    return config.allowAllChannels === true || config.allowedChannelIds.includes(channel)
  }

  /** Deny by default: an empty allowedUserIds admits nobody; "*" admits anyone. */
  function userAllowed(userId) {
    if (typeof userId !== 'string') return false
    return config.allowedUserIds.includes('*') || config.allowedUserIds.includes(userId)
  }

  function botAllowed(event) {
    return (event.user !== undefined && config.allowedBotIds.includes(event.user))
      || (event.bot_id !== undefined && config.allowedBotIds.includes(event.bot_id))
  }

  /** Who may answer permission prompts and questions: allowed humans only. */
  function isApprover(userId) {
    return userAllowed(userId) && !config.allowedBotIds.includes(userId)
  }

  function mentionsSelf(text) {
    return self.userId !== undefined && (text.includes('<@' + self.userId + '>') || text.includes('<@' + self.userId + '|'))
  }

  // ── labels & context ─────────────────────────────────────────────────────

  async function userName(userId) {
    if (!userLookups || typeof userId !== 'string') return undefined
    const cached = userNames.get(userId)
    if (cached !== undefined && now() - cached.at < 6 * 3600 * 1000) return cached.name
    try {
      const user = await slack.userInfo(userId)
      const name = user?.profile?.display_name || user?.real_name || user?.name || undefined
      userNames.set(userId, { name, at: now() })
      return name
    } catch (error) {
      if (error?.slackError === 'missing_scope') {
        userLookups = false
        logger.warn('users.info needs the users:read scope; senders are shown by id only')
      }
      return undefined
    }
  }

  async function labelFor(message) {
    const isBot = isBotEvent(message)
    const name = isBot ? (message.bot_profile?.name ?? message.username) : await userName(message.user)
    return senderLabel({ name, userId: message.user, botId: message.bot_id, isBot })
  }

  function unverified(message) {
    if (isBotEvent(message)) return !botAllowed(message)
    return !userAllowed(message.user)
  }

  async function toEntries(messages, rootTs) {
    const entries = []
    for (const message of messages) {
      if (!MESSAGE_SUBTYPES.has(message.subtype)) continue
      const text = (message.text ?? '').trim()
      if (text.length === 0) continue
      entries.push({
        label: await labelFor(message),
        text: stripSelfMention(text, self.userId),
        isParent: message.ts === rootTs,
        isSelf: isSelf(message),
        unverified: unverified(message),
      })
    }
    return entries
  }

  /**
   * Context blocks for one turn. In a thread: the thread messages since the
   * watermark (all of them, capped, the first time). For a message that opens
   * a new thread in a channel: the channel's recent top-level messages.
   */
  async function buildContexts(record, event) {
    const contexts = []
    const inThread = event.thread_ts !== undefined && event.thread_ts !== event.ts
    try {
      if (inThread && config.threadContextMessages > 0) {
        const watermark = store.get(record.key)?.watermark
        const messages = (await slack.replies(record.channel, record.threadTs, { oldest: watermark }))
          .filter((m) => Number(m.ts) < Number(event.ts))
          // A session that already has history saw its own replies.
          .filter((m) => record.fresh || !isSelf(m))
          .slice(-config.threadContextMessages)
        const block = contextBlock('[Thread context — prior messages in this thread (not yet in conversation history):]', await toEntries(messages, record.threadTs))
        if (block !== undefined) contexts.push(block)
      } else if (!inThread && !record.isDm && record.fresh && config.channelContextMessages > 0) {
        const messages = (await slack.history(record.channel, { latest: event.ts, limit: config.channelContextMessages })).reverse()
        const block = contextBlock('[Channel context — recent messages in this channel before this thread (not in conversation history):]', await toEntries(messages, undefined))
        if (block !== undefined) contexts.push(block)
      }
    } catch (error) {
      warnOnce('ctx:' + (error?.slackError ?? 'error'), 'context backfill failed (' + errorText(error) + '); continuing without it')
    }
    return contexts
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  function makeRecord(sessionId, key, channel, threadTs, isDm, fresh) {
    const record = { sessionId, key, channel, threadTs, isDm, fresh, busy: false, texts: [], queue: [], triggerTs: undefined, mentionTarget: undefined, startedAt: 0 }
    records.set(sessionId, record)
    recordsByKey.set(key, record)
    return record
  }

  function dropRecord(record) {
    records.delete(record.sessionId)
    if (recordsByKey.get(record.key) === record) recordsByKey.delete(record.key)
  }

  async function createSession(key, channel, threadTs, isDm) {
    const body = {
      location: { directory: config.channelCwd[channel] ?? config.cwd },
      metadata: { source: 'slack', channel, threadTs },
    }
    if (config.model !== undefined) body.model = config.model
    if (config.agent !== undefined) body.agent = config.agent
    if (config.permissions !== undefined) body.permissions = config.permissions
    const info = await opencode.createSession(body)
    try {
      await opencode.putInstructions(info.id, 'slack', buildInstructions({
        botName: self.name, botUserId: self.userId, isDm, channel, threadTs,
        mentionUserIds: config.mentionUserIds, extra: config.instructions,
      }))
    } catch (error) {
      logger.warn('could not inject Slack instructions into ' + info.id + ': ' + errorText(error))
    }
    store.bind(key, info.id)
    logger.info('thread ' + key + ' → new session ' + info.id)
    return makeRecord(info.id, key, channel, threadTs, isDm, true)
  }

  /** The thread's record: live, re-attached from the state file, or new. */
  async function ensureSession(key, channel, threadTs, isDm) {
    const live = recordsByKey.get(key)
    if (live !== undefined) return live
    const bound = store.get(key)
    if (bound !== undefined) {
      try {
        await opencode.getSession(bound.sessionId)
        return makeRecord(bound.sessionId, key, channel, threadTs, isDm, false)
      } catch (error) {
        if (error?.status !== 404) throw error
        logger.warn('session ' + bound.sessionId + ' for ' + key + ' is gone; starting a new one')
        store.unbind(key)
      }
    }
    return createSession(key, channel, threadTs, isDm)
  }

  /** The Slack thread a session (or one of its subagents) reports to. */
  async function targetFor(sessionId) {
    let id = sessionId
    for (let depth = 0; depth < 5 && id !== undefined; depth++) {
      const record = records.get(id)
      if (record !== undefined) return record
      const key = store.keyOf(id)
      if (key !== undefined) {
        const [channel, threadTs] = key.split(':')
        return makeRecord(id, key, channel, threadTs, channel.startsWith('D'), false)
      }
      if (!parents.has(id)) {
        try {
          parents.set(id, (await opencode.getSession(id))?.parentID ?? null)
        } catch {
          parents.set(id, null)
        }
      }
      id = parents.get(id) ?? undefined
    }
    return undefined
  }

  // ── replies ──────────────────────────────────────────────────────────────

  async function post(channel, threadTs, text) {
    try {
      return await slack.postMessage(channel, text, { threadTs })
    } catch (error) {
      logger.warn('postMessage to ' + channel + ' failed: ' + errorText(error))
      return undefined
    }
  }

  /** A control/notice message in a thread. */
  function notice(channel, threadTs, text) {
    return post(channel, threadTs, toSlackMrkdwn(text, mrkdwnOptions))
  }

  /** The agent's reply: formatted, split, the first chunk mentioning the sender. */
  async function sendReply(record, text, mentionTarget) {
    let first = true
    for (const raw of splitMessage(text, config.maxReplyChars)) {
      const prefix = first && mentionTarget !== undefined ? '<@' + mentionTarget + '> ' : ''
      first = false
      for (const piece of splitMessage(prefix + toSlackMrkdwn(raw, mrkdwnOptions), config.maxReplyChars + 200)) {
        if ((await post(record.channel, record.threadTs, piece)) === undefined) return
      }
    }
  }

  function swapReaction(record, ts, outcome) {
    if (ts === undefined) return
    const working = config.reactions.working
    const final = config.reactions[outcome]
    if (working) void slack.unreact(record.channel, ts, working)
    if (final) void slack.react(record.channel, ts, final)
  }

  // ── turns ────────────────────────────────────────────────────────────────

  async function startTurn(record, item) {
    record.busy = true
    record.texts = []
    record.triggerTs = item.ts
    record.mentionTarget = item.mentionTarget
    record.startedAt = now()
    try {
      await opencode.prompt(record.sessionId, item.text)
    } catch (error) {
      await settle(record, 'failed', { message: 'could not reach opencode — ' + errorText(error) })
    }
  }

  async function drain(record) {
    if (record.busy || record.queue.length === 0) return
    await startTurn(record, record.queue.shift())
  }

  /** One turn ended: post the reply, swap the reaction, release the thread. */
  async function settle(record, outcome, info) {
    if (!record.busy) return
    const reply = config.replyMode === 'last' ? record.texts.at(-1) : record.texts.join('\n\n')
    let text
    if (outcome === 'done') {
      text = reply !== undefined && reply.trim().length > 0 ? reply : '(Finished without a text reply.)'
    } else if (outcome === 'failed') {
      text = (reply ? reply + '\n\n' : '') + 'Turn failed: ' + (info?.message ?? info?.type ?? 'unknown error')
    } else {
      text = info?.reason === undefined || info.reason === 'user' ? 'Stopped.' : 'Stopped (' + info.reason + ').'
    }
    const triggerTs = record.triggerTs
    const mentionTarget = record.mentionTarget
    record.busy = false
    record.texts = []
    record.triggerTs = undefined
    record.mentionTarget = undefined
    record.fresh = false
    await sendReply(record, text, outcome === 'done' || outcome === 'failed' ? mentionTarget : undefined)
    swapReaction(record, triggerTs, outcome === 'done' ? 'done' : outcome === 'failed' ? 'failed' : 'stopped')
    await drain(record)
  }

  /**
   * Turns whose end event may have been missed (event stream reconnect, or a
   * turn that has been quiet too long): a session that is no longer active is
   * settled from its stored history.
   */
  async function reconcile({ olderThanMs = 0 } = {}) {
    const busy = [...records.values()].filter((r) => r.busy && now() - r.startedAt >= olderThanMs)
    if (busy.length === 0) return
    const active = await opencode.activeSessionIds()
    for (const record of busy) {
      if (active.has(record.sessionId) || !record.busy) continue
      try {
        const history = await opencode.messages(record.sessionId)
        const last = history.find((m) => m.type === 'assistant' && (m.time?.created ?? 0) >= record.startedAt - 5000)
        const text = (last?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n\n')
        if (text.length > 0) record.texts = [text]
      } catch (error) {
        logger.warn('history fetch for ' + record.sessionId + ' failed: ' + errorText(error))
      }
      logger.warn('settling ' + record.sessionId + ' from history (its end event was not seen)')
      await settle(record, 'done')
    }
  }

  // ── opencode events ──────────────────────────────────────────────────────

  async function handleOpencodeEvent(event) {
    const data = event?.data
    switch (event?.type) {
      case 'session.text.ended': {
        const record = records.get(data?.sessionID)
        if (record?.busy && typeof data.text === 'string') record.texts.push(data.text)
        return
      }
      case 'session.execution.succeeded': {
        const record = records.get(data?.sessionID)
        if (record?.busy) await settle(record, 'done')
        return
      }
      case 'session.execution.failed': {
        const record = records.get(data?.sessionID)
        if (record?.busy) await settle(record, 'failed', data.error)
        return
      }
      case 'session.execution.interrupted': {
        const record = records.get(data?.sessionID)
        if (record?.busy) await settle(record, 'stopped', { reason: data.reason })
        return
      }
      case 'session.created': {
        if (data?.parentID !== undefined) parents.set(data.sessionID, data.parentID)
        return
      }
      case 'permission.asked': {
        const target = await targetFor(data?.sessionID)
        if (target !== undefined) await interactions.openPermission(target, data)
        return
      }
      case 'permission.replied':
        return interactions.settledElsewhere(data?.requestID, 'Answered in another client: *' + data?.reply + '*')
      case 'form.created': {
        const target = await targetFor(data?.form?.sessionID)
        if (target !== undefined) await interactions.openForm(target, data.form)
        return
      }
      case 'form.replied':
        return interactions.settledElsewhere(data?.id, 'Answered in another client.')
      case 'form.cancelled':
        return interactions.settledElsewhere(data?.id, 'Cancelled in another client.')
      default:
    }
  }

  // ── Slack events ─────────────────────────────────────────────────────────

  /** A known `!verb args` (or `/verb`); anything else is ordinary text. */
  function parseCommand(body) {
    const match = /^[!/]([a-z]+)\b\s*([\s\S]*)$/i.exec(body)
    if (match === null || !COMMANDS.has(match[1].toLowerCase())) return undefined
    return { verb: match[1].toLowerCase(), args: match[2].trim() }
  }

  function mentionTargetFor(event, isBot, isDm, mentioned) {
    if (isDm || !mentioned || typeof event.user !== 'string') return undefined
    if (config.replyMention === 'off') return undefined
    if (config.replyMention === 'humans' && isBot) return undefined
    return event.user
  }

  async function runCommand(command, ctx) {
    const { channel, threadTs, key, event } = ctx
    const record = recordsByKey.get(key)
    switch (command.verb) {
      case 'help':
      case 'start':
        return notice(channel, threadTs, HELP_TEXT)
      case 'id':
        return notice(channel, threadTs, 'Channel `' + channel + '`, thread `' + threadTs + '`, you are `' + event.user + '`')
      case 'new': {
        if (record?.busy) {
          record.queue.length = 0
          try { await opencode.interrupt(record.sessionId) } catch { /* best effort */ }
        }
        if (record !== undefined) dropRecord(record)
        const had = store.unbind(key)
        return notice(channel, threadTs, had ? 'This thread is detached from its session. The next message starts a fresh one.' : 'No session in this thread yet — mention me to start one.')
      }
      case 'stop': {
        if (record === undefined || !record.busy) return notice(channel, threadTs, 'Nothing is running.')
        record.queue.length = 0
        try {
          await opencode.interrupt(record.sessionId)
        } catch (error) {
          return notice(channel, threadTs, 'Could not stop: ' + errorText(error))
        }
        return undefined // the interrupted event posts "Stopped."
      }
      case 'steer': {
        if (command.args.length === 0) return notice(channel, threadTs, 'Usage: `!steer <text>`')
        if (record === undefined || !record.busy) return submit({ ...ctx, body: command.args })
        try {
          await opencode.prompt(record.sessionId, (await labelFor(event)) + ' ' + command.args, { delivery: 'steer' })
          void slack.react(channel, event.ts, 'ok_hand')
        } catch (error) {
          await notice(channel, threadTs, 'Could not steer: ' + errorText(error))
        }
        return undefined
      }
      case 'status': {
        const bound = store.get(key)
        if (bound === undefined) return notice(channel, threadTs, 'No session in this thread.')
        let model = 'server default'
        try {
          const info = await opencode.getSession(bound.sessionId)
          if (info?.model) model = info.model.providerID + '/' + info.model.id
        } catch { /* keep default */ }
        const state = record?.busy ? 'running' + (record.queue.length > 0 ? ' (' + record.queue.length + ' queued)' : '') : 'idle'
        return notice(channel, threadTs, 'Session `' + bound.sessionId + '` — ' + state + ' — model `' + model + '`' + (interactions.hasPending(channel, threadTs) ? ' — waiting for an answer above' : ''))
      }
      case 'allow':
      case 'always':
      case 'deny':
      case 'answer':
      case 'cancel': {
        if (!isApprover(event.user)) return notice(channel, threadTs, 'Only allowed users can answer prompts.')
        if (command.verb === 'answer' && command.args.length === 0) return notice(channel, threadTs, 'Usage: `!answer <text>`')
        const consumed = await interactions.answerFromText(channel, threadTs, command.verb, command.args, event.user)
        if (consumed) return undefined
        return notice(channel, threadTs, command.verb === 'answer' || command.verb === 'cancel' ? 'No question is waiting in this thread.' : 'No permission prompt is waiting in this thread.')
      }
      default:
        return undefined
    }
  }

  async function submit(ctx) {
    const { channel, threadTs, key, isDm, event, isBot, mentioned, body } = ctx
    let record
    try {
      record = await ensureSession(key, channel, threadTs, isDm)
    } catch (error) {
      logger.warn('session for ' + key + ' unavailable: ' + errorText(error))
      void slack.react(channel, event.ts, config.reactions.failed)
      return notice(channel, threadTs, 'Could not open an opencode session: ' + errorText(error))
    }
    const contexts = await buildContexts(record, event)
    const text = composePrompt({ contexts, label: await labelFor(event), text: body })
    store.mark(key, event.ts)
    const item = { text, ts: event.ts, mentionTarget: mentionTargetFor(event, isBot, isDm, mentioned) }
    if (config.reactions.working) void slack.react(channel, event.ts, config.reactions.working)
    if (record.busy) {
      record.queue.push(item)
      const waiting = interactions.hasPending(channel, threadTs) ? ' Answer the prompt above to continue.' : ''
      return notice(channel, threadTs, 'Queued (' + record.queue.length + ' pending).' + waiting)
    }
    return startTurn(record, item)
  }

  /** Handle one Slack message event. Callers serialize these. */
  async function handleEvent(event) {
    if (event?.type !== 'message' || !MESSAGE_SUBTYPES.has(event.subtype)) return
    if (isSelf(event)) return
    const channel = event.channel
    if (typeof channel !== 'string' || typeof event.ts !== 'string') return
    const seenKey = channel + ':' + event.ts
    if (seen.has(seenKey)) return
    seen.add(seenKey)
    if (seen.size > 5000) seen.delete(seen.values().next().value)

    const text = (event.text ?? '').trim()
    if (text.length === 0) return
    const isDm = event.channel_type === 'im' || (event.channel_type === undefined && channel.startsWith('D'))
    const isBot = isBotEvent(event)
    const mentioned = mentionsSelf(text)
    const threadTs = event.thread_ts !== undefined && event.thread_ts !== event.ts ? event.thread_ts : event.ts
    const key = threadKey(channel, threadTs)

    if (!channelAllowed(channel, isDm)) {
      if (mentioned || isDm) warnOnce('ch:' + channel, 'ignoring channel ' + channel + ' (not in allowedChannelIds)')
      return
    }
    if (isBot) {
      if (!botAllowed(event) || !mentioned) return
      const verdict = guard.charge(channel)
      if (verdict === 'tripped') logger.warn('bot loop guard tripped in ' + channel + '; ignoring bot messages for ' + config.loopGuard.cooldownSeconds + 's')
      if (verdict !== 'ok') return
    } else if (!userAllowed(event.user)) {
      if (mentioned || isDm) warnOnce('user:' + event.user, 'ignoring user ' + event.user + ' (not in allowedUserIds)')
      return
    }

    const body = stripSelfMention(text, self.userId)
    const bound = store.get(key) !== undefined
    const addressed = isDm || mentioned
    const ctx = { channel, threadTs, key, isDm, event, isBot, mentioned, body }

    const command = parseCommand(body)
    if (command !== undefined && (addressed || bound)) {
      if (isBot) return // bots talk to the agent, never drive the bridge
      return runCommand(command, ctx)
    }

    // A plain reply answers a pending free-text question in this thread.
    if (!isBot && (addressed || bound) && interactions.hasPending(channel, threadTs)) {
      if (await interactions.answerFromText(channel, threadTs, undefined, body, event.user)) return
    }

    if (!addressed) return
    if (body.length === 0) return notice(channel, threadTs, HELP_TEXT)
    return submit(ctx)
  }

  return {
    identify,
    handleEvent,
    handleOpencodeEvent,
    handleInteractive: (payload) => interactions.handleAction(payload),
    reconcile,
    dispose: () => interactions.disposeAll(),
    // for tests
    _records: records,
    _store: store,
    _interactions: interactions,
  }
}
