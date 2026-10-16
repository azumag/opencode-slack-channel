// Bot-to-bot loop guard, after the Hermes gateway's bot_loop_guard: one
// budget per channel. When maxEvents bot-authored messages have arrived within
// windowSeconds, bot messages in that channel are dropped for cooldownSeconds.
// Humans are never counted or blocked.

export function createLoopGuard({ maxEvents = 20, windowSeconds = 300, cooldownSeconds = 600, now = () => Date.now() } = {}) {
  const hits = new Map()
  const cooldownUntil = new Map()

  return {
    /**
     * Charge one bot message to the channel's budget.
     * @returns 'ok' to process it, 'tripped' when this message tripped the
     *   guard, 'cooling' while the channel is in cooldown.
     */
    charge(channel) {
      const t = now()
      const until = cooldownUntil.get(channel)
      if (until !== undefined) {
        if (t < until) return 'cooling'
        cooldownUntil.delete(channel)
        hits.delete(channel)
      }
      const windowStart = t - windowSeconds * 1000
      const list = (hits.get(channel) ?? []).filter((at) => at > windowStart)
      if (list.length >= maxEvents) {
        cooldownUntil.set(channel, t + cooldownSeconds * 1000)
        hits.set(channel, list)
        return 'tripped'
      }
      list.push(t)
      hits.set(channel, list)
      return 'ok'
    },
  }
}
