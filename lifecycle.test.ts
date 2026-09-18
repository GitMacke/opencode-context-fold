import { expect, test } from "bun:test"
import { Message } from "@opencode/ai"
import { createView, prepareFold, render } from "./core"
import { activate, boundary, loadState, project, readyFolds, type SavedFold } from "./lifecycle"

const input = {
  start: "First episode begins.",
  end: "First episode ends.",
  summary: "Found the first issue.",
}
const prose = `${input.start} ${"Investigated files and found facts. ".repeat(20)} ${input.end}`
const text = (id: string, content: string) => Message.make({ id, role: "assistant", content })
const user = (id: string) => Message.make({ id, role: "user", content: "Continue" })
const reason = (id: string) =>
  Message.make({
    id,
    role: "assistant",
    content: [
      { type: "reasoning", text: "", providerMetadata: { anthropic: { signature: `secret-${id}` } } },
    ],
  })
const toolResult = (id: string) =>
  Message.make({
    role: "tool",
    content: [{ type: "tool-result", id, name: "fold", result: { type: "text", value: "queued" } }],
  })
const finished = boundary([
  { id: "u1", type: "user" },
  { id: "fold-call", type: "assistant", finish: "stop", time: { completed: 1 } },
  { id: "u2", type: "user" },
])

test("later substantive tool work survives, obsolete signatures don't, fresh reasoning survives reload", () => {
  const base = [user("u1"), reason("before"), text("a1", prose)]
  const fold: SavedFold = {
    ...prepareFold(createView(base), input),
    status: "pending",
    turn: "u1",
    messageID: "fold-call",
  }
  const later = [
    reason("later"),
    Message.make({
      id: "call",
      role: "assistant",
      providerMetadata: { openai: { phase: "commentary", itemId: "old-item" } },
      content: [
        {
          type: "tool-call",
          id: "c1",
          name: "shell",
          input: { command: "git status" },
          providerMetadata: { google: { thoughtSignature: "signed-call" } },
        },
      ],
    }),
    Message.make({
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "shell",
          result: { type: "text", value: "Unrelated useful output" },
        },
      ],
    }),
    Message.make({
      id: "answer",
      role: "assistant",
      providerMetadata: { openai: { phase: "final_answer" } },
      content: [
        {
          type: "text",
          text: "Final conclusion",
          providerMetadata: { google: { thoughtSignature: "signed-answer" } },
        },
      ],
    }),
    user("u2"),
  ]
  const messages = [...base, ...later]
  const state = { ...loadState(undefined), folds: [fold] }
  const activated = activate(createView(messages), state, finished)
  const serialized = JSON.stringify(render(activated.view))
  expect(serialized).toContain("Unrelated useful output")
  expect(serialized).toContain("Final conclusion")
  expect(serialized).toContain('"id":"c1"')
  expect(serialized).toContain("final_answer")
  expect(serialized).toContain("commentary")
  expect(serialized).toContain("secret-before")
  expect(serialized).not.toContain("secret-later")
  expect(serialized).not.toContain("signed-call")
  expect(serialized).not.toContain("signed-answer")
  expect(serialized).not.toContain("old-item")
  const saved = loadState(JSON.parse(JSON.stringify(activated.state)))
  const replayed = project([...messages, reason("fresh")], saved)
  expect(replayed.skipped).toEqual([])
  expect(JSON.stringify(render(replayed.view))).toContain("secret-fresh")
  expect(JSON.stringify(render(replayed.view))).not.toContain("secret-later")
})

test("a completed fold tool result makes a pending fold ready in the same turn", () => {
  const base = [user("u1"), text("a1", prose)]
  const fold: SavedFold = {
    ...prepareFold(createView(base), input),
    status: "pending",
    turn: "u1",
    messageID: "current",
  }
  const messages = [...base, toolResult("f1")]
  const state = { ...loadState(undefined), folds: [fold], calls: { f1: fold.id } }
  const ready = readyFolds(messages, state)
  const activated = activate(createView(messages), state, undefined, ready)

  expect(ready).toEqual(new Set([fold.id]))
  expect(activated.state.folds[0].status).toBe("active")
  expect(activated.activated).toEqual([fold.id])
  expect(JSON.stringify(render(activated.view))).toContain(`[folded ${fold.id}]`)
  expect(JSON.stringify(render(activated.view))).not.toContain("Investigated files")
})

test("nesting after a reset replays onto the same stable source identities", () => {
  const messages = [
    user("u1"),
    text("outer-start", "Outer episode starts."),
    text("a1", prose),
    reason("later"),
    text("outer-end", "Outer episode ends."),
    user("u2"),
  ]
  const first: SavedFold = {
    ...prepareFold(createView(messages), input),
    status: "pending",
    turn: "u1",
    messageID: "fold-call",
  }
  const activated = activate(createView(messages), { ...loadState(undefined), folds: [first] }, finished)
  const outer: SavedFold = {
    ...prepareFold(activated.view, {
      start: "Outer episode starts.",
      end: "Outer episode ends.",
      summary: "All resolved.",
    }),
    status: "pending",
    turn: "u2",
    messageID: "second-fold-call",
  }
  expect(outer.original).toContain(first.id)
  const next = boundary([
    { id: "u2", type: "user" },
    { id: "second-fold-call", type: "assistant", finish: "stop", time: { completed: 1 } },
    { id: "u3", type: "user" },
  ])
  const second = activate(
    activated.view,
    { ...activated.state, folds: [...activated.state.folds, outer] },
    next,
  )
  const replayed = project([...messages, user("u3")], loadState(JSON.parse(JSON.stringify(second.state))))
  expect(replayed.skipped).toEqual([])
  expect(JSON.stringify(render(replayed.view))).toContain(outer.id)
  expect(JSON.stringify(render(replayed.view))).not.toContain(first.id)
})

test("media archives round-trip captured bytes and are removed from the folded request", () => {
  const bytes = new Uint8Array([137, 80, 78, 71])
  const messages = [
    text("a", "Screenshot episode begins."),
    Message.make({
      id: "img",
      role: "user",
      content: [{ type: "media", mediaType: "image/png", data: bytes, filename: "screen.png" }],
    }),
    text("b", "Screenshot episode ends."),
  ]
  const fold = prepareFold(createView(messages), {
    start: "Screenshot episode begins.",
    end: "Screenshot episode ends.",
    summary: "Login error.",
  })
  const archived = JSON.parse(JSON.stringify(fold))
  expect(archived.content).toContainEqual({
    type: "file",
    uri: "data:image/png;base64,iVBORw==",
    mime: "image/png",
    name: "screen.png",
  })
  const active = activate(
    createView(messages),
    { ...loadState(undefined), folds: [{ ...fold, status: "pending", turn: "u1", messageID: "fold-call" }] },
    finished,
  )
  expect(JSON.stringify(render(active.view))).not.toContain('"type":"media"')
  expect(JSON.stringify(render(active.view))).toContain(fold.id)
})

test("mixed tool attachments preserve the file in peek while retaining a valid result envelope", () => {
  const messages = [
    Message.make({ role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: {} }] }),
    text("a", "Image episode begins."),
    Message.make({
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "A screenshot" },
              { type: "file", uri: "data:image/png;base64,iVBORw==", mime: "image/png" },
            ],
          },
        },
      ],
    }),
    text("b", "Image episode ends."),
  ]
  const fold = prepareFold(createView(messages), {
    start: "Image episode begins.",
    end: "Image episode ends.",
    summary: "Screenshot checked.",
  })
  expect(fold.content?.some((item) => item.type === "file")).toBe(true)
  const active = activate(
    createView(messages),
    { ...loadState(undefined), folds: [{ ...fold, status: "pending", turn: "u1", messageID: "fold-call" }] },
    finished,
  )
  const output = render(active.view)
  expect(JSON.stringify(output)).toContain('"type":"tool-result"')
  expect(JSON.stringify(output)).not.toContain("iVBORw==")
})

test("provider checkpoints remain hard boundaries and the error says where", () => {
  const checkpoint = Message.make({
    role: "assistant",
    content: [{ type: "compaction", provider: "test" as never, encrypted: "opaque-checkpoint" }],
  })
  const messages = [text("a", input.start), checkpoint, text("b", `More facts. ${input.end}`)]
  expect(() => prepareFold(createView(messages), input)).toThrow(
    `provider checkpoint right after ${JSON.stringify(input.start)}`,
  )
})

test("system messages inside a range stay in place and are not archived", () => {
  const messages = [
    text("a", `${input.start} ${"Facts. ".repeat(20)}`),
    Message.system("New instructions"),
    text("b", `More facts. ${input.end}`),
  ]
  const fold = prepareFold(createView(messages), input)
  expect(fold.original).not.toContain("New instructions")
  const output = render(
    activate(
      createView([...messages, user("u2")]),
      {
        ...loadState(undefined),
        folds: [{ ...fold, status: "pending", turn: "u1", messageID: "fold-call" }],
      },
      finished,
    ).view,
  )
  expect(output.map((message) => message.role)).toEqual(["assistant", "system", "user"])
  expect(JSON.stringify(output)).toContain("New instructions")
  expect(JSON.stringify(output)).toContain(`[folded ${fold.id}]`)
  expect(JSON.stringify(output)).not.toContain("More facts.")
})

test("v1 archive IDs and content survive state migration", () => {
  const fold = prepareFold(createView([text("a1", prose)]), input)
  const state = loadState({ version: 1, folds: [fold], expansions: {}, calls: { oldCall: fold.id } })
  expect(state.version).toBe(2)
  expect(state.folds[0].id).toBe(fold.id)
  expect(state.folds[0].original).toBe(fold.original)
  expect(project([text("a1", prose)], state).skipped).toEqual([])
})

test("a rewrite referencing a missing archive is skipped instead of blocking the request", () => {
  const state = {
    ...loadState(undefined),
    rewrites: [{ folds: ["missing"], peeks: [], reset: { retired: [], cleaned: [] } }],
  }
  const result = project([text("a1", prose)], state)
  expect(result.skipped).toEqual(["missing"])
  expect(JSON.stringify(render(result.view))).toContain(input.start)
})

test("peek expiry resets only reasoning generated before shortening, including after reload", () => {
  const messages = [
    user("u1"),
    Message.make({
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "p1",
          name: "peek",
          result: {
            type: "content",
            value: [
              { type: "text", text: prose },
              { type: "file", uri: "data:image/png;base64,iVBORw==", mime: "image/png" },
            ],
          },
        },
      ],
    }),
    reason("after-peek"),
    user("u2"),
  ]
  const state = { ...loadState(undefined), expansions: { p1: { id: "archive-id", turn: "u1" } } }
  const activated = activate(createView(messages), state, finished)
  const output = JSON.stringify(render(activated.view))
  expect(output).toContain("call peek again")
  expect(output).not.toContain("iVBORw==")
  expect(output).not.toContain("secret-after-peek")
  const reloaded = project(
    [...messages, reason("fresh")],
    loadState(JSON.parse(JSON.stringify(activated.state))),
  )
  expect(JSON.stringify(render(reloaded.view))).toContain("secret-fresh")
  expect(JSON.stringify(render(reloaded.view))).not.toContain("secret-after-peek")
})

test("reloads cannot activate old pending work halfway through a new turn", () => {
  const completed = [
    { id: "u1", type: "user" },
    { id: "a1", type: "assistant", finish: "stop", time: { completed: 1 } },
    { id: "u2", type: "user" },
  ]
  expect(boundary([...completed, { id: "draft", type: "assistant", content: [] }]).closed).toBe(true)
  expect(
    boundary([...completed, { id: "a2", type: "assistant", content: [{ type: "reasoning" }] }]).closed,
  ).toBe(false)
  expect(
    boundary([...completed, { id: "a2", type: "assistant", finish: "tool-calls", time: { completed: 2 } }])
      .closed,
  ).toBe(false)
})
