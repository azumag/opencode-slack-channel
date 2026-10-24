#!/usr/bin/env node
// Hand the bot's secrets to another machine through a chat (Slack) without
// ever posting them in plain text: X25519 + HKDF-SHA256 + AES-256-GCM.
//
//   on the target:  node deploy/secrets.mjs keygen <keyFile>
//                   → prints a one-line public key (osc-pub1:…); the private key stays in <keyFile> (600)
//   on the source:  node deploy/secrets.mjs seal <osc-pub1:…> [--tokens FILE] [--auth FILE --provider ID …] [--zen-key FILE]
//                   → prints a one-line sealed blob (osc-sealed1:…)
//                     --zen-key: an OpenCode Zen API key, from an opencode auth.json (its "opencode" api entry)
//                     or a file holding just the key
//   on the target:  node deploy/secrets.mjs open <keyFile> <osc-sealed1:…> --tokens-out FILE [--auth-out FILE] [--env-out FILE]
//                   → writes the Slack tokens file, merges providers into an opencode auth.json and/or sets
//                     OPENCODE_API_KEY in an env file (all 600), then deletes <keyFile> (one key per handoff)
//
// No secret value is ever written to stdout/stderr; only names and counts.

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PUB_PREFIX = 'osc-pub1:'
const SEALED_PREFIX = 'osc-sealed1:'
const INFO = Buffer.from('opencode-slack-channel secrets handoff v1')

function die(message, code = 1) {
  process.stderr.write('error: ' + message + '\n')
  process.exit(code)
}

function expand(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Write a file only the owner can read, atomically. */
function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function publicKeyFromX(x) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' })
}

function deriveKey(shared, ephX, recipientX) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(ephX + '.' + recipientX), INFO, 32))
}

function parseArgs(argv) {
  const positional = []
  const options = { provider: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      const value = argv[++i]
      if (value === undefined) die('missing value for ' + arg, 2)
      if (Array.isArray(options[name])) options[name].push(value)
      else options[name] = value
    } else positional.push(arg)
  }
  return { positional, options }
}

const ZEN_KEY_VAR = 'OPENCODE_API_KEY'

/** The Zen API key in an opencode auth.json ({"opencode": {"type": "api", "key"}}) or a file holding just the key. */
function readZenKey(path) {
  const text = readFileSync(expand(path), 'utf8').trim()
  let key = text
  if (text.startsWith('{')) {
    const entry = JSON.parse(text).opencode
    if (entry?.type !== 'api' || typeof entry.key !== 'string') die(path + ' has no "opencode" API key (an OAuth login is not a key: create one in the OpenCode console)')
    key = entry.key.trim()
  }
  // It goes into an env file read by both systemd and the shell: keep it to characters neither interprets.
  if (!key || /["'\\$`\s]/.test(key)) die('the Zen API key in ' + path + ' is empty or has quotes, backslashes, $, backticks or spaces')
  return key
}

/** Set NAME="value" in an env file, replacing an earlier line for the same name. */
function setEnvLine(path, name, value) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line && !line.startsWith(name + '=')) : []
  lines.push(name + '="' + value + '"')
  writePrivate(path, lines.join('\n') + '\n')
}

function keygen(keyFile) {
  if (!keyFile) die('usage: secrets.mjs keygen <keyFile>', 2)
  keyFile = expand(keyFile)
  const { privateKey } = generateKeyPairSync('x25519')
  const jwk = privateKey.export({ format: 'jwk' })
  writePrivate(keyFile, JSON.stringify(jwk) + '\n')
  process.stdout.write(PUB_PREFIX + jwk.x + '\n')
}

function seal(pub, options) {
  if (!pub?.startsWith(PUB_PREFIX)) die('usage: secrets.mjs seal <' + PUB_PREFIX + '…> [--tokens FILE] [--auth FILE --provider ID …] [--zen-key FILE]', 2)
  const recipientX = pub.slice(PUB_PREFIX.length).trim()
  const payload = { v: 1 }
  const summary = []
  if (options.tokens) {
    const tokens = JSON.parse(readFileSync(expand(options.tokens), 'utf8'))
    if (!tokens.botToken?.startsWith('xoxb-') || !tokens.appToken?.startsWith('xapp-')) die(options.tokens + ' must hold botToken (xoxb-) and appToken (xapp-)')
    payload.slack = { botToken: tokens.botToken, appToken: tokens.appToken }
    summary.push('slack tokens')
  }
  if (options.provider.length > 0) {
    if (!options.auth) die('--provider needs --auth <opencode auth.json>', 2)
    const auth = JSON.parse(readFileSync(expand(options.auth), 'utf8'))
    payload.opencodeAuth = {}
    for (const id of options.provider) {
      if (!auth[id]) die('provider ' + id + ' is not in ' + options.auth)
      payload.opencodeAuth[id] = auth[id]
    }
    summary.push('opencode auth: ' + options.provider.join(', '))
  }
  if (options.zenKey) {
    payload.zenApiKey = readZenKey(options.zenKey)
    summary.push('Zen API key')
  }
  if (summary.length === 0) die('nothing to seal (give --tokens, --auth + --provider and/or --zen-key)', 2)

  const recipient = publicKeyFromX(recipientX)
  const { privateKey: ephPrivate, publicKey: ephPublic } = generateKeyPairSync('x25519')
  const ephX = ephPublic.export({ format: 'jwk' }).x
  const key = deriveKey(diffieHellman({ privateKey: ephPrivate, publicKey: recipient }), ephX, recipientX)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const blob = Buffer.concat([Buffer.from(ephX, 'base64url'), iv, cipher.getAuthTag(), body]).toString('base64url')
  process.stdout.write(SEALED_PREFIX + blob + '\n')
  process.stderr.write('sealed: ' + summary.join(' + ') + '\n')
}

function open(keyFile, sealed, options) {
  if (!keyFile || !sealed?.startsWith(SEALED_PREFIX)) die('usage: secrets.mjs open <keyFile> <' + SEALED_PREFIX + '…> --tokens-out FILE [--auth-out FILE] [--env-out FILE]', 2)
  keyFile = expand(keyFile)
  if (!existsSync(keyFile)) die(keyFile + ' not found — run keygen on this machine first (the key is deleted after one successful open)')
  const jwk = JSON.parse(readFileSync(keyFile, 'utf8'))
  const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length).replace(/\s+/g, ''), 'base64url')
  if (raw.length < 32 + 12 + 16 + 1) die('sealed blob is truncated')
  const ephX = raw.subarray(0, 32).toString('base64url')
  const iv = raw.subarray(32, 44)
  const tag = raw.subarray(44, 60)
  const body = raw.subarray(60)
  const key = deriveKey(diffieHellman({ privateKey: createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: publicKeyFromX(ephX) }), ephX, jwk.x)
  let payload
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    payload = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'))
  } catch {
    die('cannot open the blob: it was sealed for a different key, or was changed/truncated when copied')
  }

  const written = []
  if (payload.slack) {
    if (!options.tokensOut) die('the blob holds Slack tokens: give --tokens-out <file>', 2)
    writePrivate(expand(options.tokensOut), JSON.stringify(payload.slack, null, 2) + '\n')
    written.push('slack tokens → ' + options.tokensOut)
  }
  if (payload.opencodeAuth) {
    if (!options.authOut) die('the blob holds opencode auth: give --auth-out <file>', 2)
    const out = expand(options.authOut)
    const merged = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {}
    Object.assign(merged, payload.opencodeAuth)
    writePrivate(out, JSON.stringify(merged, null, 2) + '\n')
    written.push('opencode auth (' + Object.keys(payload.opencodeAuth).join(', ') + ') → ' + options.authOut)
  }
  if (payload.zenApiKey) {
    if (!options.envOut) die('the blob holds a Zen API key: give --env-out <file>', 2)
    setEnvLine(expand(options.envOut), ZEN_KEY_VAR, payload.zenApiKey)
    written.push('Zen API key → ' + ZEN_KEY_VAR + ' in ' + options.envOut)
  }
  rmSync(keyFile, { force: true })
  process.stdout.write(written.join('\n') + '\nhandoff key deleted\n')
}

const [command, ...rest] = process.argv.slice(2)
const { positional, options } = parseArgs(rest)
if (command === 'keygen') keygen(positional[0])
else if (command === 'seal') seal(positional[0], options)
else if (command === 'open') open(positional[0], positional[1], options)
else die('usage: secrets.mjs keygen|seal|open … (see the header of this file)', 2)
