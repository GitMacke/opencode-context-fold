// Plugin wiring: registers the context tools, hooks the context and
// compaction requests, and serializes all work per session so parallel tool
// calls resolve against the same snapshot the model saw.
import { mkdir, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Message } from "@opencode/ai"
import { Plugin } from "@opencode/plugin"
import {
  applyFold,
  FoldError,
  type FoldInput,
  foldStart,
  hasCheckpointAfter,
  prepareFold,
  render,
  sameFold,
  type View,
  viewChars,
} from "./core"
import {
  activate,
  activateUnfolds,
  type Boundary,
  boundary,
  loadState,
  planUnfold,
  project,
  readyFolds,
  reserve,
  type SavedFold,
  type State,
  type Unfold,
} from "./lifecycle"
import { type NudgeState, nudge } from "./nudge"
import { foldDescription, peekDescription, unfoldDescription } from "./prompts"
import { ContextFoldRpc } from "./rpc"

interface Runtime {
  state: State
  nudge: NudgeState
  request?: { messages: readonly Message[]; original: View; current: View; turn: string }
}

interface NotificationOptions {
  enabled: boolean
  duration: number
}

function notificationOptions(value: unknown): NotificationOptions {
  if (value === false) return { enabled: false, duration: 4_000 }
  if (!value || typeof value !== "object") return { enabled: true, duration: 4_000 }
  const options = value as { enabled?: unknown; duration?: unknown }
  const duration =
    typeof options.duration === "number" &&
    Number.isInteger(options.duration) &&
    options.duration >= 1 &&
    options.duration <= 60_000
      ? options.duration
      : 4_000
  return { enabled: options.enabled !== false, duration }
}

export default Plugin.define({
  id: "context-fold",
  async setup(ctx) {
    const sessions = new Map<string, Promise<Runtime>>()
    const queues = new Map<string, Promise<void>>()
    const debug = ctx.options.debug === true
    const notifications = notificationOptions(ctx.options.notifications)
    const dumpDir = path.join(os.tmpdir(), "opencode-context-fold")
    const rpc = await ctx.rpc.register(ContextFoldRpc, {})

    function load(sessionID: string): Promise<Runtime> {
      let pending = sessions.get(sessionID)
      if (!pending) {
        pending = (async () => {
          const stored = await ctx.storage.get(`sessions/${sessionID}`)
          return { state: loadState(stored), nudge: {} }
        })()
        sessions.set(sessionID, pending)
        void pending.catch(() => {
          sessions.delete(sessionID)
        })
      }
      return pending
    }

    // Tool calls in one batch share a model-visible snapshot. Serialize commits,
    // but resolve all anchors against that snapshot rather than earlier edits.
    function serial<T>(sessionID: string, operation: (runtime: Runtime) => Promise<T>): Promise<T> {
      const result = (queues.get(sessionID) ?? Promise.resolve()).then(async () =>
        operation(await load(sessionID)),
      )
      const tail = result.then(
        () => {},
        () => {},
      )
      queues.set(sessionID, tail)
      void tail.then(() => {
        if (queues.get(sessionID) === tail) queues.delete(sessionID)
      })
      return result
    }

    async function save(sessionID: string, runtime: Runtime, state: State) {
      // Persist before publishing a successful tool result or changing memory.
      await ctx.storage.set(`sessions/${sessionID}`, JSON.parse(JSON.stringify(state)))
      runtime.state = state
    }

    const receipt = (fold: SavedFold) => ({
      content: JSON.stringify({
        id: fold.id,
        status: fold.status,
        ...(fold.status === "pending" ? { applies: "next_model_request" } : {}),
        removedChars: fold.removedChars,
        ...(fold.error ? { error: fold.error } : {}),
      }),
    })

    const unfoldReceipt = (unfold: Unfold) => ({
      content: JSON.stringify({
        id: unfold.id,
        status: unfold.status === "applied" ? "unfolded" : unfold.status,
        ...(unfold.status === "pending" ? { applies: "next_model_request" } : {}),
        ...(unfold.error ? { error: unfold.error } : {}),
      }),
    })

    async function rewriteRequest(
      sessionID: string,
      runtime: Runtime,
      messages: readonly Message[],
      turn?: Boundary,
    ) {
      const projected = project(messages, runtime.state)
      const beforeChars = viewChars(projected.view)
      const unfolded = activateUnfolds(messages, runtime.state, turn)
      const restored = unfolded.state === runtime.state ? projected : project(messages, unfolded.state)
      const activated = activate(restored.view, unfolded.state, turn, readyFolds(messages, unfolded.state))
      const errors = [...unfolded.errors, ...activated.errors]
      let view = projected.view
      let persisted = activated.state === runtime.state
      if (!persisted) {
        try {
          await save(sessionID, runtime, activated.state)
          persisted = true
        } catch (error) {
          console.warn("context-fold: could not persist context changes; serving previous view", error)
        }
      }
      if (persisted) {
        view = activated.view
        if (notifications.enabled && activated.activated.length) {
          const activatedIDs = new Set(activated.activated)
          const removedChars = activated.state.folds
            .filter((fold) => activatedIDs.has(fold.id))
            .reduce((total, fold) => total + fold.removedChars, 0)
          void rpc.events
            .emit("foldsActivated", {
              sessionID,
              count: activated.activated.length,
              removedChars,
              beforeChars,
              duration: notifications.duration,
            })
            .catch((error) => console.warn("context-fold: could not send fold notification", error))
        }
        for (const error of errors) {
          console.warn("context-fold:", error)
          await ctx.session.synthetic({ sessionID, text: error })
        }
      }
      return {
        view,
        skipped: projected.skipped,
        errors: persisted ? errors : [],
        folded: persisted && activated.activated.length > 0,
      }
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "fold",
        description: foldDescription,
        input: {
          type: "object",
          properties: {
            start: { type: "string", minLength: 1 },
            end: { type: "string", minLength: 1 },
            summary: { type: "string", minLength: 1 },
          },
          required: ["start", "end", "summary"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: (input, tool) =>
          serial(tool.sessionID, async (runtime) => {
            const previous = runtime.state.calls[tool.id]
            if (previous) return receipt(runtime.state.folds.find((fold) => fold.id === previous)!)
            if (!runtime.request)
              return {
                content: JSON.stringify({
                  error: "No model-visible context snapshot. Retry after the next model request.",
                }),
              }
            try {
              let prepared = prepareFold(runtime.request.original, input as FoldInput)
              const duplicate = runtime.state.folds.find(
                (saved) =>
                  (saved.status === "active" || saved.status === "pending") && sameFold(saved, prepared),
              )
              if (duplicate) return receipt(duplicate)
              for (
                let attempt = 1;
                runtime.state.folds.some((saved) => saved.id === prepared.id);
                attempt++
              ) {
                prepared = prepareFold(runtime.request.original, input as FoldInput, attempt)
              }
              const fold: SavedFold = {
                ...prepared,
                status: "pending",
                turn: runtime.request.turn,
                messageID: tool.messageID,
              }
              if (hasCheckpointAfter(runtime.request.original, foldStart(runtime.request.original, fold)))
                throw new FoldError(
                  "A provider checkpoint follows the selection; its state cannot be rewritten.",
                )
              const current = applyFold(runtime.request.current, fold)
              const state: State = {
                ...runtime.state,
                folds: [...runtime.state.folds, fold],
                calls: { ...runtime.state.calls, [tool.id]: fold.id },
              }
              for (const unfold of Object.values(state.unfolds)) {
                if (unfold.status === "pending") planUnfold(runtime.request.messages, state, unfold.id)
              }
              await save(tool.sessionID, runtime, state)
              runtime.request.current = current
              return receipt(fold)
            } catch (error) {
              if (!(error instanceof FoldError)) throw error
              return { content: JSON.stringify({ error: error.message }) }
            }
          }),
      })
      editor.add({
        name: "unfold",
        description: unfoldDescription,
        input: {
          type: "object",
          properties: { id: { type: "string", minLength: 1 } },
          required: ["id"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: (input, tool) =>
          serial(tool.sessionID, async (runtime) => {
            const previous = runtime.state.unfolds[tool.id]
            if (previous) return unfoldReceipt(previous)
            const { id } = input as { id: string }
            const fold = runtime.state.folds.find((fold) => fold.id === id)
            if (!fold) return { content: JSON.stringify({ error: `No fold ${id} in this session.` }) }
            if (!runtime.request)
              return {
                content: JSON.stringify({
                  error: "No context snapshot. Retry after the next model request.",
                }),
              }
            const pending = Object.values(runtime.state.unfolds).find(
              (unfold) => unfold.id === id && unfold.status === "pending",
            )
            if (pending) return unfoldReceipt(pending)
            try {
              if (fold.status === "failed")
                throw new FoldError(`Fold ${id} was not applied. Its archive is available through peek.`)
              if (fold.status === "active") planUnfold(runtime.request.messages, runtime.state, id)
              const unfold: Unfold = {
                id,
                status: fold.status === "active" ? "pending" : "applied",
                turn: runtime.request.turn,
                messageID: tool.messageID,
              }
              const state: State = {
                ...runtime.state,
                folds: runtime.state.folds.map((saved) =>
                  saved.id === id && saved.status === "pending" ? { ...saved, status: "unfolded" } : saved,
                ),
                unfolds: { ...runtime.state.unfolds, [tool.id]: unfold },
              }
              await save(tool.sessionID, runtime, state)
              runtime.request.current = reserve(runtime.request.original, state)
              return unfoldReceipt(unfold)
            } catch (error) {
              if (!(error instanceof FoldError)) throw error
              return { content: JSON.stringify({ error: error.message }) }
            }
          }),
      })
      editor.add({
        name: "peek",
        description: peekDescription,
        input: {
          type: "object",
          properties: { id: { type: "string", minLength: 1 } },
          required: ["id"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: (input, tool) =>
          serial(tool.sessionID, async (runtime) => {
            const { id } = input as { id: string }
            const fold = runtime.state.folds.find((fold) => fold.id === id)
            if (!fold) return { content: JSON.stringify({ error: `No fold ${id} in this session.` }) }
            if (!runtime.request)
              return {
                content: JSON.stringify({
                  error: "No context snapshot. Retry after the next model request.",
                }),
              }
            await save(tool.sessionID, runtime, {
              ...runtime.state,
              expansions: { ...runtime.state.expansions, [tool.id]: { id, turn: runtime.request.turn } },
            })
            if (fold.content)
              return {
                content: [
                  { type: "text" as const, text: `[peeked ${id}; ${fold.status}; historical content]` },
                  ...fold.content,
                  { type: "text" as const, text: `[/peeked ${id}]` },
                ],
              }
            return {
              content: `[peeked ${id}; ${fold.status}${fold.error ? `: ${fold.error}` : ""}; historical content]\n${fold.original}\n[/peeked ${id}]`,
            }
          }),
      })
    })

    await ctx.session.hook("context", (event) =>
      serial(event.sessionID, async (runtime) => {
        const before = event.messages
        const history = await ctx.session.context({ sessionID: event.sessionID })
        const turn = boundary(history)
        const rewritten = await rewriteRequest(event.sessionID, runtime, before, turn)
        const { view, skipped } = rewritten
        event.messages = render(view)
        runtime.request = {
          messages: before,
          original: view,
          current: reserve(view, runtime.state),
          turn: turn.turn,
        }
        if (ctx.options.nudges !== false && event.tools.fold) {
          try {
            const models = await ctx.catalog.model.list()
            const model = models.data.find(
              (model) => model.id === event.model.id && model.providerID === event.model.providerID,
            )
            const reminder = nudge(
              runtime.nudge,
              history,
              event.model,
              model?.limit.context ?? 0,
              rewritten.folded,
            )
            if (reminder) event.system.push({ type: "text", text: reminder })
          } catch (error) {
            console.warn("context-fold: could not check context pressure", error)
          }
        }
        for (const id of skipped)
          console.warn(`context-fold: fold ${id} no longer matches the transcript and was skipped`)
        if (debug) {
          try {
            await mkdir(dumpDir, { recursive: true })
            const filename = path.join(dumpDir, `${event.sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
            const dump = {
              sessionID: event.sessionID,
              capturedAt: new Date().toISOString(),
              model: event.model,
              messageIDs: before.map((message) => message.id ?? null),
              folds: runtime.state.folds.map(({ id, status, removedChars, error }) => ({
                id,
                status,
                removedChars,
                error,
              })),
              skipped,
              boundary: { turn: turn.turn, closed: turn.closed },
              resets: runtime.state.rewrites.map(({ reset }) => ({
                retired: reset.retired.length,
                cleaned: reset.cleaned.length,
              })),
              visibleChars: viewChars(view),
              system: event.system,
              before,
              after: event.messages,
            }
            await writeFile(`${filename}.tmp`, JSON.stringify(dump, null, 2), { mode: 0o600 })
            await rename(`${filename}.tmp`, filename)
          } catch (error) {
            console.warn("context-fold: diagnostic dump failed", error)
          }
        }
      }),
    )

    await ctx.session.hook("compaction", (event) =>
      serial(event.sessionID, async (runtime) => {
        // Compaction does not advance a user turn, but it is still a model
        // request and can safely consume folds from a completed tool batch.
        const rewritten = await rewriteRequest(event.sessionID, runtime, event.messages)
        event.messages = render(rewritten.view)
        if (runtime.state.folds.some((fold) => fold.status === "active")) {
          event.system.push({
            type: "text",
            text: "Preserve relevant [folded ID] markers and their summaries in the checkpoint, copying IDs exactly so peek can retrieve historical detail.",
          })
        }
      }),
    )

    return async () => {
      sessions.clear()
      await rpc.dispose()
    }
  },
})
