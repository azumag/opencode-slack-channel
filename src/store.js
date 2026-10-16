// Thread → opencode session bindings, persisted so a restart resumes the
// conversation in each Slack thread instead of silently starting over.
//
// Key: "<channel>:<thread root ts>". Value: { sessionId, watermark, updatedAt }
// where watermark is the ts of the newest thread message already handed to
// the session (the thread-context backfill starts after it).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function threadKey(channel, threadTs) {
  return channel + ':' + threadTs
}

export function createStore(stateFile, { logger } = {}) {
  let state = load(stateFile)

  function save() {
    if (stateFile === undefined) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = stateFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, stateFile)
    } catch (error) {
      logger?.warn('state file write failed: ' + (error?.message ?? String(error)))
    }
  }

  return {
    get(key) {
      return state.threads[key]
    },
    bind(key, sessionId) {
      state.threads[key] = { sessionId, watermark: undefined, updatedAt: new Date().toISOString() }
      save()
      return state.threads[key]
    },
    unbind(key) {
      if (state.threads[key] === undefined) return false
      delete state.threads[key]
      save()
      return true
    },
    /** Advance the watermark (never backwards). */
    mark(key, ts) {
      const entry = state.threads[key]
      if (entry === undefined || ts === undefined) return
      if (entry.watermark !== undefined && Number(entry.watermark) >= Number(ts)) return
      entry.watermark = ts
      entry.updatedAt = new Date().toISOString()
      save()
    },
    /** key for a session id, or undefined. */
    keyOf(sessionId) {
      for (const [key, entry] of Object.entries(state.threads)) if (entry.sessionId === sessionId) return key
      return undefined
    },
    size: () => Object.keys(state.threads).length,
  }
}

function load(stateFile) {
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.threads !== null && typeof parsed.threads === 'object') return parsed
    } catch { /* absent or corrupt: start empty */ }
  }
  return { version: 1, threads: {} }
}
