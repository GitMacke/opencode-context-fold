// Per-session state and the fold lifecycle: pending -> active | failed.
// `project` replays persisted rewrites onto a fresh transcript, `boundary`
// decides whether a real user turn has completed, and `activate` promotes
// pending folds (and expires old peek results) at that boundary, recording the
// reasoning reset needed to keep provider replay signatures consistent.
import type { Message } from "@opencode/ai"
import {
  applyFold,
  collapsePeekView,
  createView,
  type Fold,
  FoldError,
  foldStart,
  hasCheckpointAfter,
  peekStart,
  type Reset,
  resetFrom,
  resetView,
  type View,
} from "./core"

export interface Expansion {
  id: string
  turn: string
}
export interface SavedFold extends Fold {
  status: "pending" | "active" | "failed"
  turn?: string
  messageID?: string
  error?: string
}
interface Rewrite {
  folds: string[]
  peeks: string[]
  reset: Reset
}
export interface State {
  version: 2
  folds: SavedFold[]
  rewrites: Rewrite[]
  expansions: Record<string, Expansion & { collapsed?: boolean }>
  calls: Record<string, string>
}

export function loadState(value: unknown): State {
  if (value === undefined) return { version: 2, folds: [], rewrites: [], expansions: {}, calls: {} }
  const state = value as State
  if (!state || !Array.isArray(state.folds) || !state.calls || !state.expansions)
    throw new Error("context-fold: invalid stored state")
  if ((value as { version: number }).version === 1) {
    return {
      ...state,
      version: 2,
      folds: state.folds.map((fold) => ({ ...fold, status: "active" })),
      rewrites: [
        { folds: state.folds.map((fold) => fold.id), peeks: [], reset: { retired: [], cleaned: [] } },
      ],
    }
  }
  if (state.version !== 2 || !Array.isArray(state.rewrites))
    throw new Error("context-fold: unrecognized stored state version")
  return state
}

export function project(messages: readonly Message[], state: State): { view: View; skipped: string[] } {
  let view = createView(messages)
  const skipped: string[] = []
  const folds = new Map(state.folds.map((fold) => [fold.id, fold]))
  for (const rewrite of state.rewrites) {
    for (const id of rewrite.folds) {
      const fold = folds.get(id)
      // A missing archive means corrupted storage. Skip it rather than blocking
      // every request in the session.
      if (!fold) {
        skipped.push(id)
        continue
      }
      try {
        view = applyFold(view, fold)
      } catch (error) {
        if (!(error instanceof FoldError)) throw error
        skipped.push(id)
      }
    }
    view = resetView(collapsePeekView(view, rewrite.peeks), rewrite.reset)
  }
  return { view, skipped }
}

interface HistoryItem {
  id: string
  type: string
  finish?: string
  error?: unknown
  time?: { completed?: unknown }
  content?: { type: string; state?: { status: string } }[]
}
export interface Boundary {
  turn: string
  closed: boolean
  completed: Set<string>
}

// A new user message can be steering an unfinished tool loop. Require durable
// evidence of a finished response BEFORE that real user message, not an idle
// event or a guessed role/phase in the outgoing model transcript.
export function boundary(history: readonly unknown[]): Boundary {
  const items = history as readonly HistoryItem[]
  const user = items.findLastIndex((item) => item.type === "user")
  const prior = items.slice(0, user < 0 ? 0 : user)
  const last = prior.findLastIndex((item) => item.type === "assistant")
  const assistant = prior[last]
  // The host may already have created an empty assistant draft before dispatch.
  // Any actual output after this user means its first-request boundary has passed
  // (including plugin reloads and provider switches in the middle of a loop).
  const started = items
    .slice(user + 1)
    .some(
      (item) => item.type === "assistant" && ((item.content?.length ?? 0) > 0 || item.finish !== undefined),
    )
  const closed =
    !started &&
    !!assistant &&
    assistant.finish === "stop" &&
    assistant.time?.completed != null &&
    !assistant.error &&
    (assistant.content ?? []).every(
      (part) => part.type !== "tool" || part.state?.status === "completed" || part.state?.status === "error",
    )
  return {
    turn: user < 0 ? "initial" : items[user].id,
    closed,
    completed: new Set(closed ? prior.slice(0, last + 1).map((item) => item.id) : []),
  }
}

export function reserve(view: View, state: State): View {
  for (const fold of state.folds) {
    if (fold.status !== "pending") continue
    try {
      view = applyFold(view, fold)
    } catch (error) {
      if (!(error instanceof FoldError)) throw error
    }
  }
  return view
}

export function activate(
  view: View,
  state: State,
  turn: Boundary,
): { state: State; view: View; errors: string[] } {
  if (!turn.closed) return { state, view, errors: [] }
  let current = view
  let earliest = view.length
  const errors: string[] = []
  const accepted: string[] = []
  const folds = state.folds.map((fold): SavedFold => {
    if (fold.status !== "pending" || fold.turn === turn.turn) return fold
    try {
      if (!fold.messageID || !turn.completed.has(fold.messageID))
        throw new FoldError("Originating tool call is no longer in completed history.")
      const start = foldStart(view, fold)
      if (hasCheckpointAfter(view, start))
        throw new FoldError("A provider checkpoint follows the selection; its state cannot be rewritten.")
      current = applyFold(current, fold)
      earliest = Math.min(earliest, start)
      accepted.push(fold.id)
      return { ...fold, status: "active" }
    } catch (error) {
      if (!(error instanceof FoldError)) throw error
      errors.push(
        `Fold ${fold.id} was not applied: ${error.message} Its archive is still available through peek; retry with fresh anchors if useful.`,
      )
      return { ...fold, status: "failed", error: error.message }
    }
  })
  const peeks = Object.entries(state.expansions)
    .filter(([, entry]) => !entry.collapsed && entry.turn !== turn.turn)
    .map(([id]) => id)
  const start = peekStart(view, peeks)
  // Keep the attachment available if shortening it would rewrite native state.
  const shortened = hasCheckpointAfter(view, start) ? [] : peeks
  if (shortened.length) earliest = Math.min(earliest, start)
  if (!accepted.length && !shortened.length && !errors.length) return { state, view, errors }
  const reset = resetFrom(view, earliest)
  const rewrite: Rewrite = { folds: accepted, peeks: shortened, reset }
  const expansions = { ...state.expansions }
  for (const id of shortened) expansions[id] = { ...expansions[id], collapsed: true }
  return {
    state: {
      ...state,
      folds,
      expansions,
      rewrites: accepted.length || shortened.length ? [...state.rewrites, rewrite] : state.rewrites,
    },
    view: resetView(collapsePeekView(current, shortened), reset),
    errors,
  }
}
