// Permission requests and forms (questions) answered from Slack.
//
// A Slack-driven session has no client of its own, so a permission.asked or
// form.created event would otherwise wait on a UI nobody has open. Each one
// is posted into the session's thread with Block Kit buttons (text commands
// as fallback), and is settled exactly once: by a click, a text command, an
// answer from another client (permission.replied / form.replied /
// form.cancelled), or the deadline. A permission that times out is rejected
// (fail-closed); a form that times out is cancelled.
//
// Only approvers (authorized humans — never bots) can answer.

import { randomUUID } from 'node:crypto'
import { escape } from './format.js'

const MAX_BUTTONS = 20

export function createInteractions({ config, logger, slack, opencode, isApprover }) {
  /** promptId → prompt */
  const prompts = new Map()
  /** permission request id / form id → promptId */
  const byRemoteId = new Map()

  const minutes = Math.round(config.interactiveTimeoutMs / 60000)

  function errorText(error) {
    return error?.message ?? String(error)
  }

  function arm(prompt) {
    if (config.interactiveTimeoutMs <= 0) return
    prompt.timer = setTimeout(() => {
      void expire(prompt).catch((error) => logger.warn('prompt expiry failed: ' + errorText(error)))
    }, config.interactiveTimeoutMs)
    prompt.timer.unref?.()
  }

  function register(prompt) {
    prompts.set(prompt.id, prompt)
    byRemoteId.set(prompt.remoteId, prompt.id)
    arm(prompt)
  }

  function retire(prompt) {
    prompt.settled = true
    clearTimeout(prompt.timer)
    prompts.delete(prompt.id)
    byRemoteId.delete(prompt.remoteId)
  }

  async function rewrite(prompt, text) {
    if (prompt.messageTs === undefined) return
    try {
      await slack.updateMessage(prompt.channel, prompt.messageTs, text, { blocks: [section(text)] })
    } catch (error) {
      logger.warn('prompt rewrite failed: ' + errorText(error))
    }
  }

  async function post(prompt, text, blocks) {
    try {
      const posted = await slack.postMessage(prompt.channel, text, { threadTs: prompt.threadTs, blocks })
      prompt.messageTs = posted.ts
      return true
    } catch (error) {
      logger.warn('prompt post failed: ' + errorText(error))
      return false
    }
  }

  // ── permissions ──────────────────────────────────────────────────────────

  function permissionSummary(data) {
    const resources = (data.resources ?? []).slice(0, 8).map((r) => '`' + String(r).replaceAll('`', "'").slice(0, 200) + '`')
    const more = (data.resources ?? []).length > 8 ? '\n…and ' + (data.resources.length - 8) + ' more' : ''
    const lines = [':lock: *opencode asks for permission* — `' + String(data.action ?? 'action').replaceAll('`', "'") + '`']
    if (resources.length > 0) lines.push(resources.join('\n') + more)
    if (typeof data.message === 'string' && data.message.trim().length > 0) lines.push('> ' + escape(data.message.trim()).replace(/\n/g, '\n> '))
    if (Array.isArray(data.save) && data.save.length > 0) lines.push('_Always allow_ remembers: ' + data.save.slice(0, 4).map((s) => '`' + String(s).replaceAll('`', "'").slice(0, 100) + '`').join(', '))
    return lines.join('\n')
  }

  /** Post a permission prompt for one permission.asked event. */
  async function openPermission(target, data) {
    if (byRemoteId.has(data.id)) return
    const prompt = {
      id: randomUUID(), kind: 'permission', remoteId: data.id, sessionId: data.sessionID,
      channel: target.channel, threadTs: target.threadTs, summary: permissionSummary(data), settled: false,
    }
    const blocks = [
      section(prompt.summary),
      context(minutes > 0 ? `Answer within ${minutes} min, or it is denied. Text: \`!allow\` / \`!always\` / \`!deny\`` : 'Text: `!allow` / `!always` / `!deny`'),
      {
        type: 'actions',
        elements: [
          button('Allow once', 'ocs_perm_once', prompt.id, 'primary'),
          button('Always allow', 'ocs_perm_always', prompt.id),
          button('Deny', 'ocs_perm_reject', prompt.id, 'danger'),
        ],
      },
    ]
    register(prompt)
    if (!(await post(prompt, 'opencode asks for permission: ' + (data.action ?? ''), blocks))) {
      // Could not show it: fail closed now rather than block the turn.
      await decidePermission(prompt, 'reject', undefined, 'could not be shown in Slack')
    }
  }

  async function decidePermission(prompt, decision, userId, reason) {
    if (prompt.settled) return false
    retire(prompt)
    try {
      await opencode.replyPermission(prompt.sessionId, prompt.remoteId, decision, reason)
    } catch (error) {
      logger.warn('permission reply failed: ' + errorText(error))
      await rewrite(prompt, prompt.summary + '\n:warning: Could not deliver the answer: ' + escape(errorText(error)))
      return true
    }
    const verdict = { once: ':white_check_mark: *Allowed once*', always: ':white_check_mark: *Always allowed*', reject: ':no_entry: *Denied*' }[decision]
    const by = userId === undefined ? (reason ? ' — ' + escape(reason) : '') : ' by <@' + userId + '>'
    await rewrite(prompt, prompt.summary + '\n' + verdict + by)
    return true
  }

  // ── forms ────────────────────────────────────────────────────────────────

  function whenHolds(field, answers, form) {
    if (!Array.isArray(field.when) || field.when.length === 0) return true
    return field.when.every((cond) => {
      const source = form.fields.find((f) => f.key === cond.key)
      const value = cond.key in answers ? answers[cond.key] : source?.default
      return cond.op === 'eq' ? value === cond.value : value !== cond.value
    })
  }

  function nextField(prompt) {
    const { form, answers, skipped } = prompt
    return form.fields.find((field) => field.hidden !== true && !(field.key in answers) && !skipped.has(field.key) && whenHolds(field, answers, form))
  }

  function fieldText(prompt, field) {
    const head = ':question: *' + escape(prompt.form.title || 'opencode has a question') + '*'
    const title = field.title ? '\n*' + escape(field.title) + '*' : ''
    const desc = field.description ? '\n' + escape(field.description) : ''
    return head + title + desc
  }

  function renderField(prompt, field) {
    const blocks = [section(fieldText(prompt, field))]
    const elements = []
    let hint
    const options = field.type === 'string' || field.type === 'multiselect' ? field.options ?? [] : []
    if (field.type === 'boolean') {
      elements.push(button('Yes', 'ocs_form_true', prompt.id + '|' + field.key + '|true', 'primary'))
      elements.push(button('No', 'ocs_form_false', prompt.id + '|' + field.key + '|false'))
    } else if (options.length > 0 && options.length <= MAX_BUTTONS) {
      options.forEach((option, i) => {
        const picked = field.type === 'multiselect' && prompt.selection.has(option.value)
        elements.push(button((picked ? '✓ ' : '') + option.label, 'ocs_form_opt_' + i, prompt.id + '|' + field.key + '|' + i))
      })
      if (field.type === 'multiselect') elements.push(button('Submit selection', 'ocs_form_submit', prompt.id + '|' + field.key, 'primary'))
      if (field.custom === true) hint = 'Or answer in your own words: `!answer <text>`'
    } else if (options.length > 0) {
      hint = 'Options: ' + options.map((o) => '`' + o.value + '`').join(', ') + '\nAnswer with `!answer <value>`' + (field.type === 'multiselect' ? ' (comma-separated)' : '')
    } else if (field.type === 'external') {
      blocks.push(section('<' + String(field.url).replace(/[<>|]/g, encodeURIComponent) + '|Open link>'))
      elements.push(button('Done', 'ocs_form_done', prompt.id + '|' + field.key, 'primary'))
    } else {
      hint = 'Reply in this thread with your answer (or `!answer <text>`).'
    }
    if (field.required !== true) elements.push(button('Skip', 'ocs_form_skip', prompt.id + '|' + field.key))
    elements.push(button('Cancel', 'ocs_form_cancel', prompt.id, 'danger'))
    if (hint !== undefined) blocks.push(context(hint))
    if (minutes > 0) blocks.push(context(`Answer within ${minutes} min, or the question is cancelled.`))
    blocks.push({ type: 'actions', elements })
    return blocks
  }

  /** Show (or re-show) the current field, or submit when nothing is left. */
  async function advance(prompt) {
    const field = nextField(prompt)
    if (field === undefined) return submitForm(prompt)
    prompt.field = field
    prompt.selection = new Set(field.type === 'multiselect' && Array.isArray(field.default) ? field.default : [])
    const blocks = renderField(prompt, field)
    const text = 'opencode has a question: ' + (field.title ?? prompt.form.title ?? '')
    if (prompt.messageTs === undefined) {
      if (!(await post(prompt, text, blocks))) await cancelForm(prompt, undefined, 'could not be shown in Slack')
      return
    }
    try {
      await slack.updateMessage(prompt.channel, prompt.messageTs, text, { blocks })
    } catch (error) {
      logger.warn('form rewrite failed: ' + errorText(error))
    }
  }

  async function submitForm(prompt) {
    if (prompt.settled) return
    retire(prompt)
    try {
      await opencode.replyForm(prompt.sessionId, prompt.remoteId, prompt.answers)
    } catch (error) {
      logger.warn('form reply failed: ' + errorText(error))
      await rewrite(prompt, ':warning: *' + escape(prompt.form.title || 'Question') + '* — the answer was refused: ' + escape(errorText(error)))
      return
    }
    const summary = Object.entries(prompt.answers).map(([key, value]) => '• ' + escape(key) + ': ' + escape(Array.isArray(value) ? value.join(', ') : String(value))).join('\n')
    await rewrite(prompt, ':white_check_mark: *' + escape(prompt.form.title || 'Question') + '* — answered' + (prompt.lastUser ? ' by <@' + prompt.lastUser + '>' : '') + (summary ? '\n' + summary : ''))
  }

  async function cancelForm(prompt, userId, reason) {
    if (prompt.settled) return false
    retire(prompt)
    try {
      await opencode.cancelForm(prompt.sessionId, prompt.remoteId, reason ?? (userId ? 'Cancelled from Slack' : undefined))
    } catch (error) {
      logger.warn('form cancel failed: ' + errorText(error))
    }
    await rewrite(prompt, ':no_entry: *' + escape(prompt.form.title || 'Question') + '* — cancelled' + (userId ? ' by <@' + userId + '>' : reason ? ' — ' + escape(reason) : ''))
    return true
  }

  /** Coerce one typed answer for a field; returns { value } or { error }. */
  function coerce(field, raw) {
    const text = raw.trim()
    if (field.type === 'number' || field.type === 'integer') {
      const n = Number(text)
      if (!Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n))) return { error: 'expected ' + (field.type === 'integer' ? 'an integer' : 'a number') }
      return { value: n }
    }
    if (field.type === 'boolean') {
      if (/^(y|yes|true|はい|1)$/i.test(text)) return { value: true }
      if (/^(n|no|false|いいえ|0)$/i.test(text)) return { value: false }
      return { error: 'expected yes or no' }
    }
    if (field.type === 'multiselect') {
      const picks = text.split(',').map((s) => s.trim()).filter(Boolean)
      const resolved = picks.map((p) => field.options.find((o) => o.value === p || o.label === p)?.value ?? (field.custom ? p : undefined))
      if (resolved.includes(undefined)) return { error: 'unknown option' }
      return { value: resolved }
    }
    if (field.type === 'string' && Array.isArray(field.options) && field.options.length > 0 && field.custom !== true) {
      const match = field.options.find((o) => o.value === text || o.label === text)
      if (match === undefined) return { error: 'pick one of the listed options' }
      return { value: match.value }
    }
    return { value: text }
  }

  /** Post a form for one form.created event. */
  async function openForm(target, form) {
    if (byRemoteId.has(form.id)) return
    const prompt = {
      id: randomUUID(), kind: 'form', remoteId: form.id, sessionId: form.sessionID, form,
      channel: target.channel, threadTs: target.threadTs, answers: {}, skipped: new Set(), selection: new Set(), settled: false,
    }
    register(prompt)
    await advance(prompt)
  }

  // ── settlement paths ─────────────────────────────────────────────────────

  async function expire(prompt) {
    if (prompt.settled) return
    if (prompt.kind === 'permission') await decidePermission(prompt, 'reject', undefined, `no answer from Slack within ${minutes} min`)
    else await cancelForm(prompt, undefined, `no answer from Slack within ${minutes} min`)
  }

  /** Another client answered first: retire the Slack prompt. */
  async function settledElsewhere(remoteId, text) {
    const id = byRemoteId.get(remoteId)
    const prompt = id === undefined ? undefined : prompts.get(id)
    if (prompt === undefined || prompt.settled) return
    retire(prompt)
    await rewrite(prompt, (prompt.kind === 'permission' ? prompt.summary : ':question: *' + escape(prompt.form.title || 'Question') + '*') + '\n' + text)
  }

  /** A Block Kit click. */
  async function handleAction(payload) {
    if (payload?.type !== 'block_actions') return
    const action = payload.actions?.[0]
    const userId = payload.user?.id
    if (action === undefined || typeof action.value !== 'string') return
    const [promptId, fieldKey, arg] = action.value.split('|')
    const prompt = prompts.get(promptId)
    if (prompt === undefined || prompt.settled) return
    if (!isApprover(userId, prompt.channel)) {
      logger.warn('ignored a click from non-approver ' + userId)
      return
    }
    if (prompt.kind === 'permission') {
      const decision = { ocs_perm_once: 'once', ocs_perm_always: 'always', ocs_perm_reject: 'reject' }[action.action_id]
      if (decision !== undefined) await decidePermission(prompt, decision, userId)
      return
    }
    prompt.lastUser = userId
    if (action.action_id === 'ocs_form_cancel') return void (await cancelForm(prompt, userId))
    const field = prompt.field
    if (field === undefined || field.key !== fieldKey) return
    if (action.action_id === 'ocs_form_true' || action.action_id === 'ocs_form_false') {
      prompt.answers[field.key] = action.action_id === 'ocs_form_true'
    } else if (action.action_id === 'ocs_form_skip') {
      prompt.skipped.add(field.key)
    } else if (action.action_id === 'ocs_form_done') {
      prompt.skipped.add(field.key)
    } else if (action.action_id === 'ocs_form_submit') {
      prompt.answers[field.key] = [...prompt.selection]
    } else if (action.action_id.startsWith('ocs_form_opt_')) {
      const option = field.options?.[Number(arg)]
      if (option === undefined) return
      if (field.type === 'multiselect') {
        if (prompt.selection.has(option.value)) prompt.selection.delete(option.value)
        else prompt.selection.add(option.value)
        const blocks = renderField(prompt, field)
        try {
          await slack.updateMessage(prompt.channel, prompt.messageTs, 'opencode has a question', { blocks })
        } catch (error) {
          logger.warn('form rewrite failed: ' + errorText(error))
        }
        return
      }
      prompt.answers[field.key] = option.value
    } else {
      return
    }
    const keepSelection = field.type === 'multiselect' && !(field.key in prompt.answers)
    if (!keepSelection) await advance(prompt)
  }

  /** Oldest unsettled prompt of one kind in a thread. */
  function pending(channel, threadTs, kind) {
    for (const prompt of prompts.values()) {
      if (prompt.channel === channel && prompt.threadTs === threadTs && !prompt.settled && (kind === undefined || prompt.kind === kind)) return prompt
    }
    return undefined
  }

  /**
   * Text path. verb: 'allow' | 'always' | 'deny' | 'answer' | 'cancel', or
   * undefined for a plain message (answers a pending free-text field).
   * @returns true when the text was consumed.
   */
  async function answerFromText(channel, threadTs, verb, body, userId) {
    if (verb === 'allow' || verb === 'always' || verb === 'deny') {
      const prompt = pending(channel, threadTs, 'permission')
      if (prompt === undefined) return false
      return decidePermission(prompt, { allow: 'once', always: 'always', deny: 'reject' }[verb], userId)
    }
    const prompt = pending(channel, threadTs, 'form')
    if (prompt === undefined) return false
    if (verb === 'cancel') return cancelForm(prompt, userId)
    const field = prompt.field
    if (field === undefined) return false
    const freeText = field.type === 'string' && !(Array.isArray(field.options) && field.options.length > 0) || field.type === 'number' || field.type === 'integer'
    if (verb === undefined && !freeText) return false
    const result = coerce(field, body)
    if (result.error !== undefined) {
      try {
        await slack.postMessage(channel, 'Not accepted: ' + result.error + '.', { threadTs })
      } catch { /* best effort */ }
      return true
    }
    prompt.lastUser = userId
    prompt.answers[field.key] = result.value
    await advance(prompt)
    return true
  }

  function hasPending(channel, threadTs) {
    return pending(channel, threadTs) !== undefined
  }

  /** Teardown: forget every prompt (the server keeps its own requests). */
  function disposeAll() {
    for (const prompt of prompts.values()) clearTimeout(prompt.timer)
    prompts.clear()
    byRemoteId.clear()
  }

  return { openPermission, openForm, settledElsewhere, handleAction, answerFromText, hasPending, disposeAll, size: () => prompts.size }
}

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } }
}

function context(text) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: text.slice(0, 2900) }] }
}

function button(label, actionId, value, style) {
  const element = { type: 'button', text: { type: 'plain_text', text: label.slice(0, 75), emoji: true }, action_id: actionId, value: value.slice(0, 2000) }
  if (style !== undefined) element.style = style
  return element
}
