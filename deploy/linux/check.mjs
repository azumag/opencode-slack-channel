#!/usr/bin/env node
// Health check for a Linux install made by deploy/linux/setup.sh. Never opens
// the Slack socket (that would take events away from a bot still running
// elsewhere) and never prints a secret.
//
//   node check.mjs opencode                       exit 0 when the opencode server answers
//   node check.mjs all [--model] --bot-config F --tokens F --auth F --opencode-bin F

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
const errText = (error) => error?.message ?? String(error)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function slackCall(method, token) {
  const res = await fetch('https://slack.com/api/' + method, { method: 'POST', headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) })
  return res.json()
}

/** One tiny turn through the same API the bridge uses; the session is deleted afterwards. */
async function probeModel(opencode, config) {
  const started = Date.now()
  const body = { location: { directory: config.cwd }, metadata: { source: 'osc-check' } }
  if (config.model) body.model = config.model
  const session = await opencode.createSession(body)
  try {
    await opencode.prompt(session.id, 'Reply with exactly the word OK and nothing else. Do not use any tools.')
    let seenActive = false
    for (;;) {
      await sleep(2000)
      const active = await opencode.activeSessionIds()
      if (active.has(session.id)) seenActive = true
      else if (seenActive || Date.now() - started > 8000) break
      if (Date.now() - started > 240000) throw new Error('no answer within 240 s (rate limit wait or retry loop?)')
    }
    const last = (await opencode.messages(session.id)).find((m) => m.type === 'assistant')
    const text = (last?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim()
    const used = last?.model ? last.model.providerID + '/' + last.model.id : '?'
    const secs = Math.round((Date.now() - started) / 1000)
    if (/\bOK\b/.test(text)) ok('model answers', used + ', ' + secs + ' s')
    else if (!last) bad('model answers', 'no assistant message after ' + secs + ' s — provider error? see: setup.sh logs opencode')
    else bad('model answers', used + ' replied "' + text.slice(0, 80) + '" (finish ' + (last.finish ?? 'none') + ')')
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

let authProviders = []
if (existsSync(opts.auth)) {
  const mode = statSync(opts.auth).mode & 0o077
  authProviders = Object.keys(JSON.parse(readFileSync(opts.auth, 'utf8')))
  if (mode !== 0) bad('opencode auth', opts.auth + ' is readable by others (chmod 600)')
  else ok('opencode auth', 'providers: ' + authProviders.join(', '))
} else {
  note('opencode auth', 'none (only anonymous Zen free models will work)')
}
if (config?.model && config.model.providerID !== 'opencode' && !authProviders.includes(config.model.providerID)) {
  bad('model credentials', config.model.providerID + ' is the bot model but has no key in ' + opts.auth)
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
  } catch (error) {
    bad('Slack tokens', errText(error))
  }
}

try {
  const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  note('GitHub CLI', 'logged in as ' + login + ' — the bot acts on GitHub as this account')
} catch {
  note('GitHub CLI', 'gh missing or not logged in — the bot cannot use GitHub until it is')
}
for (const key of ['user.name', 'user.email']) {
  try {
    execFileSync('git', ['config', '--global', key], { stdio: 'ignore' })
    note('git ' + key, 'set')
  } catch {
    note('git ' + key, 'not set — commits by the bot will fail')
  }
}

if (opts.model && opencode && config) {
  try {
    await probeModel(opencode, config)
  } catch (error) {
    bad('model answers', errText(error))
  }
} else if (opts.model) {
  note('model answers', 'skipped (opencode server or bot config not OK)')
}

console.log(failures === 0 ? '\nall checks passed' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
