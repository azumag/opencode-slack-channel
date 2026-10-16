#!/usr/bin/env node
// opencode-slack-channel: run the Slack ↔ opencode v2 bridge.
//
//   node bin/opencode-slack-channel.js [config.json]
//
// Config: argv[2], $OPENCODE_SLACK_CONFIG, or ~/.config/opencode-slack-channel/config.json.
// Tokens: $SLACK_BOT_TOKEN / $SLACK_APP_TOKEN, or the tokens file (see README).

import { createBridge } from '../src/bridge.js'
import { DEFAULT_CONFIG_FILE, loadConfig, loadTokens } from '../src/config.js'
import { OpencodeClient, runEventLoop } from '../src/opencode.js'
import { SlackClient, sleep } from '../src/slack.js'
import { runSocketLoop } from '../src/socket.js'

function makeLogger() {
  const write = (level) => (message) => process.stderr.write(new Date().toISOString() + ' ' + level + ' ' + message + '\n')
  return { info: write('info '), warn: write('warn '), error: write('error') }
}

const logger = makeLogger()
const configFile = process.argv[2] ?? process.env.OPENCODE_SLACK_CONFIG ?? DEFAULT_CONFIG_FILE

let config
let tokens
try {
  config = loadConfig(configFile)
  tokens = loadTokens(config)
} catch (error) {
  logger.error(error?.message ?? String(error))
  process.exit(2)
}

const slack = new SlackClient({ apiBase: config.slack.apiBase, botToken: tokens.botToken, appToken: tokens.appToken })
const opencode = new OpencodeClient(config.opencode)
const bridge = createBridge({ config, slack, opencode, logger })
const abort = new AbortController()

const channels = config.allowAllChannels ? 'ALL' : config.allowedChannelIds.join(',') || 'none'
logger.info('config ' + configFile + ': channels=' + channels + ', DMs=' + config.allowDirectMessages + ', users=' + (config.allowedUserIds.join(',') || 'any') + ', bots=' + (config.allowedBotIds.join(',') || 'none') + ', cwd=' + config.cwd)

try {
  const info = await opencode.request('GET', '/api/info')
  logger.info('opencode ' + info?.version + ' at ' + opencode.credentials().url)
} catch (error) {
  logger.warn('opencode not reachable yet (' + (error?.message ?? String(error)) + '); will keep retrying')
}

for (let attempt = 1; ; attempt++) {
  try {
    await bridge.identify(abort.signal)
    break
  } catch (error) {
    logger.warn('auth.test failed (' + (error?.message ?? String(error)) + ')')
    if (error?.slackError === 'invalid_auth' || error?.slackError === 'not_authed') process.exit(2)
    await sleep(Math.min(30000, attempt * 2000), abort.signal)
  }
}

// Slack events and clicks run strictly in order (session creation must not
// race); opencode events have their own ordered chain so a slow Slack
// backfill never delays posting a finished reply.
let slackChain = Promise.resolve()
let opencodeChain = Promise.resolve()
const enqueueSlack = (work) => {
  slackChain = slackChain.then(work).catch((error) => logger.warn('slack handling failed: ' + (error?.message ?? String(error))))
  return slackChain
}

const socketLoop = runSocketLoop({
  slack,
  onEvent: (event) => void enqueueSlack(() => bridge.handleEvent(event)),
  onInteractive: (payload) => enqueueSlack(() => bridge.handleInteractive(payload)),
  signal: abort.signal,
  logger,
  retryDelayMs: config.retryDelayMs,
})

const eventLoop = runEventLoop({
  client: opencode,
  onEvent: (event) => {
    opencodeChain = opencodeChain.then(() => bridge.handleOpencodeEvent(event)).catch((error) => logger.warn('opencode event handling failed: ' + (error?.message ?? String(error))))
  },
  onReconnect: () => bridge.reconcile(),
  signal: abort.signal,
  logger,
  retryDelayMs: config.retryDelayMs,
})

// Sessions still executing from before this start are adopted (their end is
// posted, a pending model retry is reported). Runs after the event stream is
// started so no end event slips between the check and the subscription.
setTimeout(() => {
  opencodeChain = opencodeChain.then(() => bridge.adopt()).catch((error) => logger.warn('adopt failed: ' + (error?.message ?? String(error))))
}, 1000)

// Safety nets, once a minute: a turn quiet for 2 minutes whose session is no
// longer active is settled from history (a lost end event never leaves a
// thread busy), and the stall watchdog reports or gives up silent turns.
const sweep = setInterval(() => {
  bridge.reconcile({ olderThanMs: 120000 }).catch((error) => logger.warn('sweep failed: ' + (error?.message ?? String(error))))
  opencodeChain = opencodeChain.then(() => bridge.watchdog()).catch((error) => logger.warn('watchdog failed: ' + (error?.message ?? String(error))))
}, 60000)

logger.info('running')

async function shutdown(signal) {
  logger.info('received ' + signal + ', shutting down')
  clearInterval(sweep)
  abort.abort()
  bridge.dispose()
  await Promise.race([Promise.allSettled([socketLoop, eventLoop]), sleep(5000)])
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
