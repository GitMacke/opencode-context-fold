// Plugin wiring: registers the `fold` and `peek` tools, hooks the context and
// compaction requests, and serializes all work per session so parallel tool
// calls resolve against the same snapshot the model saw.
import { mkdir, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  applyFold,
  FoldError,
  type FoldInput,
  foldStart,
  hasCheckpointAfter,
  prepareFold,
  render,
  type View,
  viewChars,
} from "./core"
import { activate, boundary, loadState, project, reserve, type SavedFold, type State } from "./lifecycle"

interface Runtime {
  state: State
  request?: { original: View; current: View; turn: string }
}

const foldDescription = `Replace an inclusive section of visible conversation with your concise summary and a retrievable hash marker. You write the summary; no second model is called. Quote unique start and end strings exactly from message text or tool output (each within one text part; lengthen an anchor if it is ambiguous). Both anchors are included. Do not quote guessed tool-call JSON or private reasoning. Anchors and overlap are validated immediately: correct any errors now. Accepted folds are pending until a subsequent real user turn after the current assistant response finishes. Further tool work is allowed; the current response keeps its full context. Ranges may include whole reasoning blocks and captured media, and may span system messages (which stay in place), but cannot cross provider checkpoints or split tool-call/result pairs.
Use when completed exploration or redundant detail can be shortened meaningfully. Preserve conclusions, exact identifiers/paths, user constraints, uncertainties, and unfinished work in the summary. Prefer doing this before your final response to the user, only when useful; then give your final answer normally. Independent, non-overlapping folds may run in parallel. Visible summaries can themselves be folded. peek(id) retrieves visible archived content, including media and nested fold markers, not private reasoning. This changes future context, not stored session history.`

const peekDescription = `Retrieve a folded section by its hash ID, even while it is pending. Returns historical visible text and captured attachments at the end of the conversation, with role/tool labels and any nested fold markers intact. Private reasoning is not returned. The original marker stays in place. Retrieved content remains available until a subsequent user turn after the assistant response finishes, then its tool result is shortened automatically; call peek again if needed. Peek at nested IDs separately for further detail.`

export default Plugin.define({
  id: "context-fold",
  async setup(ctx) {
    const sessions = new Map<string, Promise<Runtime>>()
    const queues = new Map<string, Promise<void>>()
    const debug = ctx.options.debug === true
    const dumpDir = path.join(os.tmpdir(), "opencode-context-fold")

    function load(sessionID: string): Promise<Runtime> {
      let pending = sessions.get(sessionID)
      if (!pending) {
        pending = (async () => {
          const stored = await ctx.storage.get(`sessions/${sessionID}`)
          return { state: loadState(stored) }
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
        ...(fold.status === "pending" ? { applies: "next_turn" } : {}),
        removedChars: fold.removedChars,
        ...(fold.error ? { error: fold.error } : {}),
      }),
    })

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
              const fold: SavedFold = {
                ...prepareFold(runtime.request.original, input as FoldInput),
                status: "pending",
                turn: runtime.request.turn,
                messageID: tool.messageID,
              }
              if (hasCheckpointAfter(runtime.request.original, foldStart(runtime.request.original, fold)))
                throw new FoldError(
                  "A provider checkpoint follows the selection; its state cannot be rewritten.",
                )
              const duplicate = runtime.state.folds.find((saved) => saved.id === fold.id)
              if (duplicate && duplicate.status !== "failed") return receipt(duplicate)
              const current = applyFold(runtime.request.current, fold)
              await save(tool.sessionID, runtime, {
                ...runtime.state,
                folds: [...runtime.state.folds.filter((saved) => saved.id !== fold.id), fold],
                calls: { ...runtime.state.calls, [tool.id]: fold.id },
              })
              runtime.request.current = current
              return receipt(fold)
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
          properties: { id: { type: "string", pattern: "^[a-f0-9]{16}$" } },
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
        const turn = boundary(await ctx.session.context({ sessionID: event.sessionID }))
        const projected = project(before, runtime.state)
        const activated = activate(projected.view, runtime.state, turn)
        let view = projected.view
        const skipped = projected.skipped
        // Persist before publishing. If storage is down, serve the previous view
        // rather than blocking the request; activation is retried next time.
        let persisted = activated.state === runtime.state
        if (!persisted) {
          try {
            await save(event.sessionID, runtime, activated.state)
            persisted = true
          } catch (error) {
            console.warn("context-fold: could not persist fold activation; serving previous view", error)
          }
        }
        if (persisted) view = activated.view
        event.messages = render(view)
        runtime.request = { original: view, current: reserve(view, runtime.state), turn: turn.turn }
        for (const id of skipped)
          console.warn(`context-fold: fold ${id} no longer matches the transcript and was skipped`)
        if (persisted)
          for (const error of activated.errors) {
            console.warn("context-fold:", error)
            await ctx.session.synthetic({ sessionID: event.sessionID, text: error })
          }
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
        // Auxiliary compaction never activates pending edits or advances a turn.
        event.messages = render(project(event.messages, runtime.state).view)
        if (runtime.state.folds.some((fold) => fold.status === "active")) {
          event.system.push({
            type: "text",
            text: "Preserve relevant [folded ID] markers and their summaries in the checkpoint, copying IDs exactly so peek can retrieve historical detail.",
          })
        }
      }),
    )

    return () => {
      sessions.clear()
    }
  },
})
