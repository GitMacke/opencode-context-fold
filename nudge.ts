import { softNudge, strongNudge } from "./prompts"

interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

interface UsageMessage {
  id: string
  type: string
  model?: ModelRef
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export interface NudgeState {
  usageID?: string
  blockedID?: string
  level?: number
  remaining?: number
}

// Reported usage describes the preceding model call, not an exact count of the
// outgoing request. Never reuse pre-compaction/foreign-model usage, or usage
// measured before a newly activated fold. No tokenizer or persisted state needed.
export function nudge(
  state: NudgeState,
  history: readonly UsageMessage[],
  model: ModelRef,
  limit: number,
  folded: boolean,
): string | undefined {
  let usage: UsageMessage | undefined
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]
    if (message.type === "compaction" || message.type === "model-switched") break
    if (message.type !== "assistant" || !message.tokens) continue
    usage = message
    break
  }
  if (folded) {
    state.blockedID = usage?.id
    state.level = 2
    state.remaining = 4
  }
  if (!usage?.tokens || !usage.model || !Number.isFinite(limit) || limit <= 0) return
  if (
    usage.model.id !== model.id ||
    usage.model.providerID !== model.providerID ||
    usage.model.variant !== model.variant ||
    usage.id === state.blockedID ||
    usage.id === state.usageID
  )
    return

  const tokens = usage.tokens
  const total = tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning
  if (!Number.isFinite(total) || total <= 0) return
  state.usageID = usage.id
  const level = total >= limit * 0.8 ? 2 : total >= limit * 0.6 ? 1 : 0
  if (!level) {
    state.level = 0
    state.remaining = 0
    return
  }
  // Escalate immediately from soft to strong, but otherwise allow four fresh
  // model responses between reminders. Repeated hooks don't consume cooldown.
  if ((state.remaining ?? 0) > 0 && level <= (state.level ?? 2)) {
    state.remaining = (state.remaining ?? 0) - 1
    return
  }
  state.level = level
  state.remaining = 4
  return level === 2 ? strongNudge : softNudge
}
