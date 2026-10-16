// Markdown → Slack mrkdwn for agent replies.
//
// Modeled on the Hermes Slack adapter's format_message: tables become code
// fences, code is protected from every later pass, links/headers/emphasis are
// converted, and & < > are escaped everywhere else. Two safety rules on top:
//   - broadcast mentions (<!here>, <!channel>, <!everyone>) never survive;
//   - a user mention <@U…> survives only when its id is in mentionUserIds,
//     so the model can address a named teammate but cannot ping anyone it
//     happens to know an id for (dsh-slack-channel's allowlist rule).

const PH = '\u0000'

/**
 * Convert one reply chunk to Slack mrkdwn.
 * @param text - model output (standard markdown).
 * @param options.mentionUserIds - ids whose <@U…> mentions stay live.
 */
export function toSlackMrkdwn(text, options = {}) {
  if (text.length === 0) return text
  const allowed = new Set(options.mentionUserIds ?? [])
  const stash = []
  const ph = (value) => {
    stash.push(value)
    return PH + (stash.length - 1) + PH
  }

  let out = closeDanglingFence(wrapTables(text))

  // Code first: fenced blocks (language tag dropped — Slack renders it
  // literally), then inline spans. Both pass through untouched.
  out = out.replace(/```[^\n`]*\n[\s\S]*?```|```[\s\S]*?```/g, (block, offset, whole) => {
    const atLineStart = offset === 0 || whole[offset - 1] === '\n'
    return ph(atLineStart ? block.replace(/^```[^\s`]+[ \t]*\n/, '```\n') : block)
  })
  out = out.replace(/`[^`\n]+`/g, (span) => ph(span))

  // Markdown links → <url|label>. Only web/mail targets become links; the
  // label is escaped so it cannot smuggle an entity.
  out = out.replace(/(?<!!)\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g, (match, label, url) => {
    if (!/^(https?:|mailto:)/i.test(url)) return match
    return ph('<' + url.replace(/[<>|]/g, encodeURIComponent) + '|' + escape(label) + '>')
  })

  // Slack entities the model wrote itself: allowlisted user mentions, channel
  // links and plain web links survive; every other <…> is escaped below.
  out = out.replace(/<(@[UW][A-Z0-9]+)(\|[^<>\n]*)?>/g, (match, id) => (allowed.has(id.slice(1)) ? ph(match) : match))
  out = out.replace(/<(#C[A-Z0-9]+(?:\|[^<>\n]*)?|https?:[^<>\s]+(?:\|[^<>\n]*)?)>/g, (match) => ph(match))

  // Block quotes keep their leading ">" (it would be escaped otherwise).
  out = out.replace(/^(>+[ \t])/gm, (quote) => ph(quote))

  // Headers → bold line.
  out = out.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_, inner) => ph('*' + escape(inner.replace(/\*\*(.+?)\*\*/g, '$1')) + '*'))

  // Emphasis. Order matters: *** before ** before *.
  out = out.replace(/\*\*\*(\S(?:.*?\S)?)\*\*\*/g, (_, inner) => ph('*_' + escape(inner) + '_*'))
  out = out.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, (_, inner) => ph(bold(inner)))
  out = out.replace(/__(\S(?:.*?\S)?)__/g, (_, inner) => ph(bold(inner)))
  out = out.replace(/(?<![*\w])\*(\S(?:[^*\n]*?\S)?)\*(?![*\w])/g, (_, inner) => ph('_' + escape(inner) + '_'))
  out = out.replace(/~~(\S(?:.*?\S)?)~~/g, (_, inner) => ph('~' + escape(inner) + '~'))

  out = escape(out)

  // Restore in reverse: a stashed value may itself contain earlier tokens.
  for (let i = stash.length - 1; i >= 0; i--) out = out.replaceAll(PH + i + PH, stash[i])
  return out
}

/** Escape the three characters Slack mrkdwn reserves. */
export function escape(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Slack drops a closing * that follows punctuation and silently truncates the
 * message; a zero-width space before it keeps the bold intact (Hermes fix).
 */
function bold(inner) {
  const zw = /[\p{L}\p{N}_]$/u.test(inner) ? '' : '​'
  return '*' + escape(inner) + zw + '*'
}

/** Wrap GFM tables in code fences: Slack has no table syntax. */
function wrapTables(text) {
  const lines = text.split('\n')
  const out = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimStart().startsWith('```')) inFence = !inFence
    const isTableStart = !inFence
      && /^\s*\|.*\|\s*$/.test(line)
      && i + 1 < lines.length
      && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])
    if (!isTableStart) {
      out.push(line)
      continue
    }
    out.push('```')
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) out.push(lines[i++])
    out.push('```')
    i--
  }
  return out.join('\n')
}

/** Close an odd trailing ``` so a split chunk still renders standalone. */
function closeDanglingFence(text) {
  const fences = text.split('\n').filter((line) => line.trimStart().startsWith('```')).length
  return fences % 2 === 1 ? text + '\n```' : text
}
