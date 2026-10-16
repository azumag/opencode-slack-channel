// opencode v2 server client: HTTP + Basic auth, and the /api/event SSE stream.
//
// Credentials come from the service file the v2 background service writes on
// start (~/.local/state/opencode/service.json: { url, password, … }). It is
// re-read whenever a request is refused or the connection drops, so a service
// restart (new password, same url) is followed without restarting the bridge.

import { readFileSync } from 'node:fs'
import { sleep } from './slack.js'

/** One failed opencode API call. */
export class OpencodeError extends Error {
  constructor(method, path, status, body) {
    const tag = body?._tag
    super('opencode ' + method + ' ' + path + ' failed (' + (status ?? 'no-response') + (tag ? ' ' + tag : '') + (body?.message ? ': ' + body.message : '') + ')')
    this.name = 'OpencodeError'
    this.status = status
    this.tag = tag
    this.body = body
  }
}

export class OpencodeClient {
  #config
  #fetchImpl
  #credentials

  /**
   * @param config.url - server url; overrides the service file's url.
   * @param config.serviceFile - path of the v2 service file.
   * @param config.username - Basic auth user ("opencode").
   * @param config.password - explicit password (tests); else read from the service file.
   */
  constructor(config, { fetchImpl } = {}) {
    this.#config = config
    this.#fetchImpl = fetchImpl ?? globalThis.fetch
  }

  /** Resolve url + auth header, reading the service file when needed. */
  credentials({ refresh = false } = {}) {
    if (this.#credentials !== undefined && refresh === false) return this.#credentials
    let url = this.#config.url
    let password = this.#config.password
    if (password === undefined || url === undefined) {
      const service = JSON.parse(readFileSync(this.#config.serviceFile, 'utf8'))
      url ??= service.url
      password ??= service.password
    }
    if (typeof url !== 'string' || url.length === 0) throw new Error('opencode: no server url (service file has none and config.opencode.url is unset)')
    const headers = {}
    if (typeof password === 'string' && password.length > 0) {
      headers.authorization = 'Basic ' + Buffer.from(this.#config.username + ':' + password).toString('base64')
    }
    this.#credentials = { url: url.replace(/\/+$/, ''), headers }
    return this.#credentials
  }

  /**
   * One JSON request. A 401 re-reads the service file once (the service may
   * have restarted with a new password) before failing.
   * @returns the parsed body (undefined for 204).
   */
  async request(method, path, body, { signal, query } = {}) {
    for (let attempt = 0; ; attempt++) {
      const { url, headers } = this.credentials({ refresh: attempt > 0 })
      const target = url + path + (query === undefined ? '' : '?' + new URLSearchParams(query))
      let res
      try {
        res = await this.#fetchImpl(target, {
          method,
          headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(60000),
        })
      } catch (error) {
        if (signal?.aborted) throw error
        if (attempt === 0) continue
        throw new OpencodeError(method, path, undefined, { message: error?.message ?? String(error) })
      }
      if (res.status === 401 && attempt === 0) continue
      const text = await res.text()
      let parsed
      if (text.length > 0) {
        try { parsed = JSON.parse(text) } catch { parsed = { message: text.slice(0, 200) } }
      }
      if (!res.ok) throw new OpencodeError(method, path, res.status, parsed)
      return parsed
    }
  }

  createSession(body) {
    return this.request('POST', '/api/session', body).then((r) => r.data)
  }

  getSession(sessionId) {
    return this.request('GET', '/api/session/' + sessionId).then((r) => r.data)
  }

  /** Inject one instruction entry into the session's system prompt. */
  putInstructions(sessionId, key, value) {
    return this.request('PUT', '/api/experimental/session/' + sessionId + '/instructions/entries/' + encodeURIComponent(key), { value })
  }

  /** Submit a user message. delivery: undefined (start/steer when idle) | 'steer' | 'queue'. */
  prompt(sessionId, text, { delivery } = {}) {
    const body = { text }
    if (delivery !== undefined) body.delivery = delivery
    return this.request('POST', '/api/session/' + sessionId + '/prompt', body).then((r) => r.data)
  }

  interrupt(sessionId) {
    return this.request('POST', '/api/session/' + sessionId + '/interrupt')
  }

  /** decision: 'once' | 'always' | 'reject'. */
  replyPermission(sessionId, requestId, decision, message) {
    const body = { decision }
    if (message !== undefined) body.message = message
    return this.request('POST', '/api/session/' + sessionId + '/permission/' + requestId + '/reply', body)
  }

  replyForm(sessionId, formId, answer) {
    return this.request('POST', '/api/session/' + sessionId + '/form/' + formId + '/reply', { answer })
  }

  cancelForm(sessionId, formId, message) {
    return this.request('DELETE', '/api/session/' + sessionId + '/form/' + formId, undefined, message === undefined ? {} : { query: { message } })
  }

  /** Ids of sessions that are currently executing. */
  async activeSessionIds() {
    const result = await this.request('GET', '/api/session/active')
    return new Set(Object.keys(result?.data ?? {}))
  }

  /** Newest-first message history (one page). */
  messages(sessionId) {
    return this.request('GET', '/api/session/' + sessionId + '/message').then((r) => r.data ?? [])
  }
}

/**
 * Follow /api/event until the signal aborts, reconnecting with backoff.
 * @param options.onEvent - receives each decoded event object ({ type, data, … }).
 * @param options.onReconnect - called after every (re)connection except the
 *   first, so the caller can reconcile turns whose end it may have missed.
 */
export async function runEventLoop({ client, onEvent, onReconnect, signal, logger, retryDelayMs = 2000, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch
  let connections = 0
  while (signal.aborted === false) {
    let res
    try {
      const { url, headers } = client.credentials({ refresh: connections > 0 })
      res = await doFetch(url + '/api/event', { headers: { ...headers, accept: 'text/event-stream' }, signal })
      if (!res.ok || res.body === null) throw new Error('HTTP ' + res.status)
    } catch (error) {
      if (signal.aborted) break
      logger.warn('event stream connect failed (' + (error?.message ?? String(error)) + '); retrying in ' + retryDelayMs + 'ms')
      await sleep(retryDelayMs, signal)
      continue
    }
    connections++
    if (connections > 1) {
      logger.info('event stream reconnected')
      Promise.resolve(onReconnect?.()).catch((error) => logger.warn('reconcile failed: ' + (error?.message ?? String(error))))
    }
    try {
      for await (const event of parseSse(res.body)) {
        try {
          onEvent(event)
        } catch (error) {
          logger.warn('event handling failed: ' + (error?.message ?? String(error)))
        }
      }
    } catch (error) {
      if (signal.aborted) break
      logger.warn('event stream broke (' + (error?.message ?? String(error)) + ')')
    }
    if (signal.aborted) break
    await sleep(retryDelayMs, signal)
  }
}

/** Decode a text/event-stream body into the JSON objects of its data fields. */
export async function* parseSse(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n')
    let boundary
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n')
      if (data.length === 0) continue
      try {
        yield JSON.parse(data)
      } catch {
        // non-JSON data frame (keep-alive text): ignore
      }
    }
  }
}
