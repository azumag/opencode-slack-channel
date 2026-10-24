#!/usr/bin/env node
// Health check for a Linux install made by deploy/linux/setup.sh. Never opens
// the Slack socket (that would take events away from a bot still running
// elsewhere) and never prints a secret.
//
//   node check.mjs opencode                       exit 0 when the opencode server answers
//   node check.mjs all [--model] --bot-config F --tokens F --opencode-bin F --opencode-log F

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, loadTokens } from '../../src/config.js'
import { OpencodeClient } from '../../src/opencode.js'

const stateHome = process.env.XDG_STATE_HOME ?? join(process.env.HOME, '.local', 'state')
const serviceFile = join(stateHome, 'opencode', 'service.json')

const args = process.argv.slice(2)
const mode = args.shift()
const opts = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--model') opts.model = true
  else if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i]
}

let failures = 0
const ok = (label, detail = '') => console.log('✓ ' + label + (detail ? ' — ' + detail : ''))
const bad = (label, detail = '') => { failures++; console.log('✗ ' + label + (detail ? ' — ' + detail : '')) }
const note = (label, detail = '') => console.log('· ' + label + (detail ? ' — ' + detail : ''))
const proxied = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].some((name) => process.env[name])
const errText = (error) => {
  const cause = error?.cause
  // Node's fetch through a proxy that answers CONNECT with anything but 200 (407, 403, …) fails as
  // "Request was cancelled." with code 0 (reproduced with Node 24 and a proxy answering 407 or 403).
  if (cause?.code === 0 && proxied) return (error?.message ?? String(error)) + ' (the proxy refused the tunnel: CONNECT was not answered with 200, e.g. 407 for missing/expired proxy credentials — run setup.sh netcheck)'
  return (error?.message ?? String(error)) + (cause ? ' (' + (cause.code ?? cause.message) + ')' : '')
}
/** A tool's error line without URLs, user:pass@ or host:port (proxy settings must not be printed). */
const scrub = (text) => String(text ?? '').split('\n').find((line) => line.trim())?.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
  .replace(/\S+@\S+/g, '<…>').replace(/\b[\w.-]+:\d{2,5}\b/g, '<host:port>').slice(0, 160) ?? ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function slackCall(method, token) {
  const res = await fetch('https://slack.com/api/' + method, { method: 'POST', headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) })
  return res.json()
}

/** ERROR lines opencode wrote to its log after byte offset `from` (message + first line of the cause). */
function logErrors(file, from) {
  if (!file || !existsSync(file)) return []
  const text = readFileSync(file, 'utf8').slice(from)
  return text.split('\n').filter((line) => line.includes('level=ERROR')).map((line) => {
    const message = line.match(/message="([^"]*)"/)?.[1] ?? ''
    const cause = line.match(/cause="([^"\\]*)/)?.[1] ?? ''
    return (message + (cause ? ': ' + cause : '')).slice(0, 300)
  })
}

/**
 * Seconds until the server lists the model (a fresh opencode only knows its built-in list until
 * the models.dev catalog arrives, ~10 s after the first start), or -1 after 60 s.
 */
async function waitForModel(bin, model) {
  const id = model.providerID + '/' + model.id
  const started = Date.now()
  while (Date.now() - started < 60000) {
    try {
      const out = execFileSync(bin, ['models'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 })
      if (out.split('\n').some((line) => line.trim() === id)) return Math.round((Date.now() - started) / 1000)
    } catch { /* server busy: try again */ }
    await sleep(3000)
  }
  return -1
}

/**
 * The catalog opencode refreshes every 5 min from https://models.opencode.ai/api.json (10 s
 * timeout). While that fails, the server only has the model list built into its version.
 */
function catalogNote(logFile) {
  if (!logFile || !existsSync(logFile)) return
  // Since the server started (it rewrites service.json then), at most the last 30 min.
  const since = Math.max(Date.now() - 30 * 60000, existsSync(serviceFile) ? statSync(serviceFile).mtimeMs : 0)
  const sinceText = new Date(since).toISOString().slice(11, 16) + ' UTC'
  const failures = readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('Failed to fetch models.dev')
    && Date.parse(line.match(/timestamp=(\S+)/)?.[1] ?? '') >= since)
  if (failures.length === 0) return note('model catalog', 'no fetch failures since ' + sinceText)
  const cause = failures.at(-1).match(/cause="([^"\\]*)/)?.[1] ?? '?'
  note('model catalog', failures.length + ' failed fetch(es) of https://models.opencode.ai/api.json since ' + sinceText + ' (' + cause.slice(0, 120)
    + ') — the server only knows the models built into this opencode version; new free models will not appear')
}

/**
 * One tiny turn through the same API the bridge uses; the session is deleted afterwards.
 * `expectSwitch`: the model is one the server does not have, so passing means the fallback
 * plugin moved the session to another model.
 */
/**
 * What the running opencode server holds for an OpenCode integration ("opencode" = Zen, "opencode-go"):
 * the methods of stored logins (account labels are not read out) and whether it sees OPENCODE_API_KEY
 * in its own environment.
 */
function consoleAuth(bin, integrationID) {
  try {
    const list = JSON.parse(execFileSync(bin, ['auth', 'list', '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }))
    const connections = list.filter((integration) => integration.id === integrationID).flatMap((integration) => integration.connections ?? [])
    const envKey = connections.find((connection) => connection.type === 'env' && connection.name === 'OPENCODE_API_KEY')
    return {
      logins: connections.filter((connection) => connection.type === 'credential').map((connection) => connection.method ?? '?'),
      serverKey: envKey === undefined ? 'the opencode server does not see OPENCODE_API_KEY (restart it)' : 'the opencode server sees OPENCODE_API_KEY' + (envKey.status?.status ? ' (' + envKey.status.status + ': ' + envKey.status.message + ')' : ''),
    }
  } catch {
    return undefined
  }
}

async function probeModel(opencode, config, logFile, { label = 'model answers', model = config.model, expectSwitch = false } = {}) {
  const started = Date.now()
  const logFrom = logFile && existsSync(logFile) ? statSync(logFile).size : 0
  const body = { location: { directory: config.cwd }, metadata: { source: 'osc-check' } }
  if (model) body.model = model
  const session = await opencode.createSession(body)
  try {
    await opencode.prompt(session.id, 'Reply with exactly the word OK and nothing else. Do not use any tools.')
    // Done when the turn ran and stopped, or it failed before running (opencode logs an ERROR),
    // or it never started within 60 s. A running turn (fallbacks, retry waits) gets up to 240 s.
    let seenActive = false
    for (;;) {
      await sleep(2000)
      const elapsed = Date.now() - started
      if ((await opencode.activeSessionIds()).has(session.id)) {
        seenActive = true
        if (elapsed > 240000) throw new Error('still running after 240 s (rate-limit waits or a fallback loop?)')
        continue
      }
      if (seenActive || logErrors(logFile, logFrom).length > 0 || elapsed > 60000) break
      if ((await opencode.messages(session.id)).some((m) => m.type === 'assistant' && m.time?.completed)) break
    }
    const last = (await opencode.messages(session.id)).find((m) => m.type === 'assistant')
    const text = (last?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim()
    const used = last?.model ? last.model.providerID + '/' + last.model.id : '?'
    const secs = Math.round((Date.now() - started) / 1000)
    const answered = /\bOK\b/.test(text) && !(expectSwitch && used === model.providerID + '/' + model.id)
    if (answered) ok(label, (expectSwitch ? model.providerID + '/' + model.id + ' → ' : '') + used + ', ' + secs + ' s')
    else if (!last) bad(label, 'no reply after ' + secs + ' s')
    else bad(label, used + ' replied "' + text.slice(0, 80) + '" (finish ' + (last.finish ?? 'none') + ')')
    if (!answered) {
      const errors = logErrors(logFile, logFrom)
      if (errors.length === 0) note('opencode log', 'no ERROR lines in ' + logFile)
      for (const line of errors.slice(-3)) note('opencode log', line)
    }
  } finally {
    try { await opencode.request('DELETE', '/api/session/' + session.id) } catch { /* best effort */ }
  }
}

if (mode === 'opencode') {
  try {
    await new OpencodeClient({ serviceFile, username: 'opencode' }).request('GET', '/api/info')
    process.exit(0)
  } catch {
    process.exit(1)
  }
}

if (mode !== 'all') {
  console.error('usage: check.mjs opencode | all [--model] --bot-config F --tokens F --auth F --opencode-bin F')
  process.exit(2)
}

ok('node', process.version)
const proxyNames = Object.keys(process.env).filter((name) => /^(https?|all|no)_proxy$/i.test(name))
if (proxyNames.length === 0) note('network', 'no proxy settings: direct connections')
else note('network', 'proxy settings: ' + proxyNames.join(', ') + (process.env.NODE_USE_ENV_PROXY === '1' ? ' (the bridge uses them: NODE_USE_ENV_PROXY=1)' : ' (the bridge ignores them without NODE_USE_ENV_PROXY=1)'))
try {
  ok('opencode CLI', execFileSync(opts['opencode-bin'], ['--version'], { encoding: 'utf8' }).trim())
} catch (error) {
  bad('opencode CLI', errText(error))
}

let config
try {
  config = loadConfig(opts['bot-config'])
  ok('bot config', opts['bot-config'] + ' (channels ' + (config.allowedChannelIds.join(',') || 'none') + ', model ' + (config.model ? config.model.providerID + '/' + config.model.id : 'server default') + ')')
  if (config.opencode.serviceFile !== serviceFile) bad('bot config opencode.serviceFile', config.opencode.serviceFile + ' ≠ ' + serviceFile)
  if (existsSync(config.cwd)) ok('working directory', config.cwd)
  else bad('working directory', config.cwd + ' does not exist')
} catch (error) {
  bad('bot config', errText(error))
}

let opencode
if (config) {
  opencode = new OpencodeClient(config.opencode)
  try {
    const info = await opencode.request('GET', '/api/info')
    ok('opencode server', 'v' + info?.version + ' at ' + opencode.credentials().url)
    const active = await opencode.activeSessionIds()
    note('active sessions', String(active.size))
  } catch (error) {
    bad('opencode server', errText(error))
    opencode = undefined
  }
}

// OpenCode Zen (integration "opencode", OpenCode Console) and OpenCode Go both take OPENCODE_API_KEY.
const OPENCODE_INTEGRATIONS = { opencode: 'OpenCode Console', 'opencode-go': 'OpenCode Go' }
const modelProvider = config?.model?.providerID
if (modelProvider && !Object.hasOwn(OPENCODE_INTEGRATIONS, modelProvider)) {
  note('model credentials', modelProvider + ' needs a key in opencode (opencode2 auth login)')
}
if (modelProvider && Object.hasOwn(OPENCODE_INTEGRATIONS, modelProvider)) {
  const name = OPENCODE_INTEGRATIONS[modelProvider]
  const auth = opencode ? consoleAuth(opts['opencode-bin'], modelProvider) : undefined
  note('model credentials', [
    process.env.OPENCODE_API_KEY ? 'OpenCode API key set in the bot env (OPENCODE_API_KEY, value not shown)'
      : 'no OpenCode API key in the bot env' + (modelProvider === 'opencode' ? '' : ': ' + name + ' needs one (seal --go-key, then import)'),
    ...(auth === undefined ? [name + ' logins unknown'] : [
      auth.logins.length === 0 ? 'no stored ' + name + ' login' : 'stored ' + name + ' login: ' + auth.logins.join(', ') + (modelProvider === 'opencode' ? ' (setup.sh zen-logout removes it)' : ''),
      ...(process.env.OPENCODE_API_KEY ? [auth.serverKey] : []),
    ]),
  ].join('; '))
}

if (config) {
  try {
    const tokens = loadTokens(config)
    const auth = await slackCall('auth.test', tokens.botToken)
    if (auth.ok) ok('Slack bot token', 'bot ' + auth.user + ' (' + auth.user_id + ') in ' + auth.team)
    else bad('Slack bot token', 'auth.test: ' + auth.error)
    const conn = await slackCall('apps.connections.open', tokens.appToken)
    if (conn.ok) ok('Slack app token', 'Socket Mode URL issued (not connected)')
    else bad('Slack app token', 'apps.connections.open: ' + conn.error)
    // The socket's host over plain HTTPS, by the same route a WebSocket takes (no session, no ticket).
    const socketHost = conn.ok ? new URL(conn.url).host : 'wss-primary.slack.com'
    try {
      const res = await fetch('https://' + socketHost + '/', { signal: AbortSignal.timeout(20000) })
      ok('Slack socket host', socketHost + ' reachable (HTTP ' + res.status + ')')
    } catch (error) {
      bad('Slack socket host', socketHost + ': ' + errText(error))
    }
  } catch (error) {
    bad('Slack tokens', errText(error))
  }
}

try {
  const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim()
  note('GitHub CLI', 'logged in as ' + login + ' — the bot acts on GitHub as this account')
} catch (error) {
  if (error.code === 'ENOENT') note('GitHub CLI', 'gh not found on PATH — the bot cannot use GitHub')
  else note('GitHub CLI', 'gh api user failed (exit ' + (error.status ?? error.code) + ': ' + scrub(error.stderr) + ') — not logged in, or no network through the proxy')
}
for (const [key, envName] of [['user.name', 'GIT_AUTHOR_NAME'], ['user.email', 'GIT_AUTHOR_EMAIL']]) {
  if (process.env[envName]) {
    note('git ' + key, process.env[envName] + ' (bot env)')
    continue
  }
  try {
    execFileSync('git', ['config', '--global', key], { stdio: 'ignore' })
    note('git ' + key, 'set in ~/.gitconfig')
  } catch {
    note('git ' + key, 'not set — commits by the bot will fail (setup.sh git-identity)')
  }
}

if (opts.model && opencode && config) {
  try {
    const waited = config.model ? await waitForModel(opts['opencode-bin'], config.model) : 0
    if (waited < 0) note('model list', config.model.providerID + '/' + config.model.id + ' is not listed by the server (opencode2 models); the fallback plugin should move sessions to another model')
    if (waited > 0) note('model list', 'the model appeared after ' + waited + ' s (fresh server)')
    await probeModel(opencode, config, opts['opencode-log'])
  } catch (error) {
    bad('model answers', errText(error))
  }
  try {
    await probeModel(opencode, config, opts['opencode-log'], { label: 'model fallback', model: { providerID: config.model?.providerID ?? 'opencode', id: 'osc-check-missing-model' }, expectSwitch: true })
  } catch (error) {
    bad('model fallback', errText(error))
  }
  // After the probes: a fresh server first fetches the catalog when a model is first needed.
  catalogNote(opts['opencode-log'])
} else if (opts.model) {
  note('model answers', 'skipped (opencode server or bot config not OK)')
}

console.log(failures === 0 ? '\nall checks passed' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
