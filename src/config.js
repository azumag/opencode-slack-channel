// Configuration: a JSON file (no secrets) plus a tokens file or environment
// variables for the two Slack tokens.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const HOME = homedir()

export const DEFAULT_CONFIG_FILE = join(HOME, '.config', 'opencode-slack-channel', 'config.json')

const DEFAULTS = {
  slack: {
    apiBase: 'https://slack.com/api',
    tokensFile: join(HOME, '.config', 'opencode-slack-channel', 'tokens.json'),
  },
  opencode: {
    serviceFile: join(HOME, '.local', 'state', 'opencode', 'service.json'),
    username: 'opencode',
    url: undefined,
    password: undefined,
  },
  model: undefined,
  agent: undefined,
  cwd: join(HOME, 'work'),
  channelCwd: {},
  allowedChannelIds: [],
  allowAllChannels: false,
  allowDirectMessages: true,
  allowedUserIds: [],
  allowedBotIds: [],
  mentionUserIds: [],
  replyMention: 'always',
  loopGuard: { maxEvents: 20, windowSeconds: 300, cooldownSeconds: 600 },
  // The model provider failing (rate limit, endpoint unavailable): opencode
  // schedules retries, sometimes half an hour out. The thread is told at the
  // first retry; the turn is given up (interrupted, reported as failed) once
  // the attempt count reaches maxAttempts or the next try is further away
  // than maxWaitMs. 0 disables either limit.
  upstreamRetry: { maxAttempts: 3, maxWaitMs: 5 * 60 * 1000 },
  // A running turn with no opencode activity at all: tell the thread after
  // noticeMs, give the turn up after giveUpMs. 0 disables either.
  stall: { noticeMs: 10 * 60 * 1000, giveUpMs: 30 * 60 * 1000 },
  threadContextMessages: 30,
  channelContextMessages: 10,
  replyMode: 'last',
  maxReplyChars: 4000,
  reactions: { working: 'eyes', done: 'white_check_mark', failed: 'x', stopped: 'black_square_for_stop' },
  interactiveTimeoutMs: 30 * 60 * 1000,
  stateFile: join(HOME, '.local', 'state', 'opencode-slack-channel', 'state.json'),
  instructions: undefined,
  permissions: undefined,
  retryDelayMs: 2000,
}

/** Expand a leading ~/ to the home directory. */
function expand(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(HOME, path.slice(2)) : path
}

function fail(message) {
  throw new Error('config: ' + message)
}

function idList(value, name, pattern) {
  if (!Array.isArray(value)) fail(name + ' must be an array')
  for (const id of value) if (typeof id !== 'string' || !pattern.test(id)) fail(name + ' has an invalid id: ' + JSON.stringify(id))
  return [...new Set(value)]
}

/**
 * Validate a raw config object and fill defaults.
 * @returns the resolved config (tokens not included).
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('must be a JSON object')
  const config = {
    ...DEFAULTS,
    ...raw,
    slack: { ...DEFAULTS.slack, ...(raw.slack ?? {}) },
    opencode: { ...DEFAULTS.opencode, ...(raw.opencode ?? {}) },
    loopGuard: { ...DEFAULTS.loopGuard, ...(raw.loopGuard ?? {}) },
    upstreamRetry: { ...DEFAULTS.upstreamRetry, ...(raw.upstreamRetry ?? {}) },
    stall: { ...DEFAULTS.stall, ...(raw.stall ?? {}) },
    reactions: { ...DEFAULTS.reactions, ...(raw.reactions ?? {}) },
  }
  config.slack.tokensFile = expand(config.slack.tokensFile)
  config.opencode.serviceFile = expand(config.opencode.serviceFile)
  config.stateFile = expand(config.stateFile)
  config.cwd = expand(config.cwd)
  if (!isAbsolute(config.cwd)) fail('cwd must be absolute')
  if (config.channelCwd === null || typeof config.channelCwd !== 'object') fail('channelCwd must be an object')
  config.channelCwd = Object.fromEntries(Object.entries(config.channelCwd).map(([channel, dir]) => {
    const path = expand(dir)
    if (typeof path !== 'string' || !isAbsolute(path)) fail('channelCwd.' + channel + ' must be an absolute path')
    return [channel, path]
  }))
  config.allowedChannelIds = idList(config.allowedChannelIds, 'allowedChannelIds', /^[CGD][A-Z0-9]+$/)
  // Deny by default: an empty list lets nobody in; "*" is the explicit "anyone".
  config.allowedUserIds = idList(config.allowedUserIds, 'allowedUserIds', /^([UW][A-Z0-9]+|\*)$/)
  config.allowedBotIds = idList(config.allowedBotIds, 'allowedBotIds', /^[UWB][A-Z0-9]+$/)
  config.mentionUserIds = idList(config.mentionUserIds, 'mentionUserIds', /^[UW][A-Z0-9]+$/)
  if (!['always', 'humans', 'off'].includes(config.replyMention)) fail('replyMention must be "always", "humans" or "off"')
  if (!['last', 'all'].includes(config.replyMode)) fail('replyMode must be "last" or "all"')
  if (config.model !== undefined && (typeof config.model?.providerID !== 'string' || typeof config.model?.id !== 'string')) fail('model must be { "providerID": "…", "id": "…" }')
  for (const key of ['maxEvents', 'windowSeconds', 'cooldownSeconds']) {
    if (!Number.isFinite(config.loopGuard[key]) || config.loopGuard[key] < 0) fail('loopGuard.' + key + ' must be a non-negative number')
  }
  for (const [group, key] of [['upstreamRetry', 'maxAttempts'], ['upstreamRetry', 'maxWaitMs'], ['stall', 'noticeMs'], ['stall', 'giveUpMs']]) {
    if (!Number.isFinite(config[group][key]) || config[group][key] < 0) fail(group + '.' + key + ' must be a non-negative number')
  }
  for (const key of ['threadContextMessages', 'channelContextMessages', 'maxReplyChars', 'interactiveTimeoutMs', 'retryDelayMs']) {
    if (!Number.isFinite(config[key]) || config[key] < 0) fail(key + ' must be a non-negative number')
  }
  config.threadContextMessages = Math.min(config.threadContextMessages, 200)
  config.channelContextMessages = Math.min(config.channelContextMessages, 50)
  if (config.maxReplyChars < 500) fail('maxReplyChars must be at least 500')
  return config
}

/** Load the config file (missing file = all defaults). */
export function loadConfig(file = DEFAULT_CONFIG_FILE) {
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('cannot read ' + file + ': ' + (error?.message ?? String(error)))
  }
  return resolveConfig(raw)
}

/**
 * Slack tokens: SLACK_BOT_TOKEN / SLACK_APP_TOKEN from the environment win,
 * else the tokens file ({ "botToken": "xoxb-…", "appToken": "xapp-…" }),
 * which must not be readable by others.
 */
export function loadTokens(config, env = process.env) {
  let botToken = env.SLACK_BOT_TOKEN
  let appToken = env.SLACK_APP_TOKEN
  if (!botToken || !appToken) {
    const file = config.slack.tokensFile
    let parsed
    try {
      const mode = statSync(file).mode & 0o077
      if (mode !== 0) fail(file + ' is readable by group/others — run: chmod 600 ' + file)
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.message?.startsWith('config:')) throw error
      fail('no Slack tokens: set SLACK_BOT_TOKEN and SLACK_APP_TOKEN, or create ' + file + ' (see README)')
    }
    botToken ||= parsed.botToken
    appToken ||= parsed.appToken
  }
  if (typeof botToken !== 'string' || !botToken.startsWith('xoxb-')) fail('bot token must be the xoxb- Bot User OAuth Token')
  if (typeof appToken !== 'string' || !appToken.startsWith('xapp-')) fail('app token must be the xapp- App-Level Token (connections:write)')
  return { botToken, appToken }
}
