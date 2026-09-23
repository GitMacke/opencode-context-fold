import { nudgeText } from "./prompts"

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
  model?: string
  baseline?: number
}

// Remind the model each time its context has grown by `every` tokens since the
// last fold. The baseline is the first fresh usage reading after a fold, a
// compaction (usage drops), a model switch, or plugin start. Reported usage
// describes the preceding model call, so the reading measured before a newly
// activated fold is ignored. No tokenizer or persisted state needed.
export function nudge(
  state: NudgeState,
  history: readonly UsageMessage[],
  model: ModelRef,
  every: number,
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
    state.baseline = undefined
  }
  if (!usage?.tokens || !usage.model || !Number.isFinite(every) || every <= 0) return
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
  const key = JSON.stringify([model.providerID, model.id, model.variant ?? null])
  if (state.model !== key || state.baseline === undefined || total < state.baseline) {
    state.model = key
    state.baseline = total
    return
  }
  const growth = total - state.baseline
  if (growth < every) return
  state.baseline = total
  return nudgeText(growth)
}
