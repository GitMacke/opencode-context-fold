import { expect, test } from "bun:test"
import { Message } from "@opencode/ai"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext as SessionContextHook } from "@opencode/plugin/promise/session"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import plugin from "./index"

const prose = `First episode begins. ${"Detailed findings from the search. ".repeat(40)} First episode ends.`
const second = prose.replaceAll("First", "Second")
const original = () => [
  Message.make({ id: "u1", role: "user", content: "Find the commit" }),
  Message.make({ id: "a1", role: "assistant", content: `${prose}\n${second}` }),
]
const firstInput = { start: "First episode begins.", end: "First episode ends.", summary: "First finding." }
const secondInput = {
  start: "Second episode begins.",
  end: "Second episode ends.",
  summary: "Second finding.",
}
const nextMessages = () => [...original(), Message.make({ id: "u2", role: "user", content: "Next question" })]
const continuation = (calls: string[]) => [
  ...original(),
  Message.make({
    id: "current",
    role: "assistant",
    content: calls.map((id) => ({ type: "tool-call" as const, id, name: "fold", input: {} })),
  }),
  Message.make({
    role: "tool",
    content: calls.map((id) => ({
      type: "tool-result" as const,
      id,
      name: "fold",
      result: { type: "text" as const, value: "queued" },
    })),
  }),
]

async function harness(
  storage = new Map<string, unknown>(),
  options: Record<string, unknown> = { debug: false },
) {
  const tools = new Map<string, Info>()
  const hooks = new Map<string, (event: SessionContextHook) => void | Promise<void>>()
  let failWrites = false
  let durable: unknown[] = [{ type: "user", id: "u1" }]
  const notices: string[] = []
  const events: { name: string; data: unknown }[] = []
  const cleanup = await plugin.setup({
    options,
    location: { directory: "/unused" },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        if (failWrites) throw new Error("Simulated storage failure")
        storage.set(key, structuredClone(value))
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: Info) => void }) => void) =>
        callback({ add: (tool) => tools.set(tool.name, tool) }),
    },
    rpc: {
      register: async () => ({
        events: {
          emit: async (name: string, data: unknown) => {
            events.push({ name, data })
          },
        },
        dispose: async () => {},
      }),
    },
    session: {
      context: async () => durable,
      synthetic: async ({ text }: { text: string }) => {
        notices.push(text)
      },
      hook: async (name: string, callback: (event: SessionContextHook) => void | Promise<void>) => {
        hooks.set(name, callback)
      },
    },
  } as unknown as Context)
  return {
    storage,
    cleanup,
    notices,
    events,
    history: (items: unknown[]) => {
      durable = items
    },
    finish: () => {
      durable = [
        { type: "user", id: "u1" },
        { type: "assistant", id: "current", finish: "stop", time: { completed: 1 }, content: [] },
        { type: "user", id: "u2" },
      ]
    },
    failWrites: (value: boolean) => {
      failWrites = value
    },
    async request(messages = original(), sessionID = "s1", kind = "context", providerID = "test") {
      const event = {
        sessionID,
        agent: "build",
        model: { providerID, id: "test" },
        system: [],
        tools: {},
        messages,
        options: {},
      } as unknown as SessionContextHook
      await hooks.get(kind)!(event)
      return event
    },
    async call(name: string, input: unknown, callID: string, sessionID = "s1") {
      return tools.get(name)!.execute(input, {
        sessionID,
        messageID: "current",
        id: callID,
        agent: "build",
        progress: async () => {},
      } as unknown as ToolContext)
    },
  }
}

test("parallel tool commits survive reload and peek is session-scoped", async () => {
  const host = await harness()
  await host.request()
  const results = await Promise.all([
    host.call("fold", firstInput, "f1"),
    host.call("fold", secondInput, "f2"),
  ])
  const ids = results.map((result) => JSON.parse(result.content as string).id as string)
  expect(ids.every(Boolean)).toBe(true)
  await host.cleanup?.()
  const reloaded = await harness(host.storage)
  expect(JSON.stringify((await reloaded.request()).messages)).toContain("Detailed findings")
  reloaded.finish()
  const next = await reloaded.request(nextMessages())
  expect(JSON.stringify(next.messages)).toContain(ids[0])
  expect(JSON.stringify(next.messages)).toContain(ids[1])
  expect(JSON.stringify(next.messages)).not.toContain("Detailed findings")
  const expanded = await reloaded.call("peek", { id: ids[0] }, "e1")
  expect(expanded.content).toContain(prose)
  const other = await reloaded.call("peek", { id: ids[0] }, "e1", "s2")
  expect(other.content).toContain("No fold")
  // A retried call is acknowledged without creating a second fold.
  expect(JSON.parse((await reloaded.call("fold", firstInput, "f1")).content as string)).toMatchObject({
    id: ids[0],
    status: "active",
  })
})

test("parallel folds activate together before a same-turn continuation", async () => {
  const host = await harness()
  await host.request()
  const results = await Promise.all([
    host.call("fold", firstInput, "f1"),
    host.call("fold", secondInput, "f2"),
  ])
  expect(results.map((result) => JSON.parse(result.content as string).applies)).toEqual([
    "next_model_request",
    "next_model_request",
  ])

  const next = await host.request(continuation(["f1", "f2"]))
  const output = JSON.stringify(next.messages)
  expect(output).toContain(JSON.parse(results[0].content as string).id)
  expect(output).toContain(JSON.parse(results[1].content as string).id)
  expect(output).not.toContain("Detailed findings")
  expect(
    (host.storage.get("sessions/s1") as { folds: { status: string }[] }).folds.map((fold) => fold.status),
  ).toEqual(["active", "active"])
  expect(host.events).toEqual([
    {
      name: "foldsActivated",
      data: expect.objectContaining({
        sessionID: "s1",
        count: 2,
        removedChars: expect.any(Number),
        beforeChars: expect.any(Number),
        duration: 4_000,
      }),
    },
  ])
})

test("fold activation notifications can be disabled", async () => {
  const host = await harness(new Map(), { notifications: false })
  await host.request()
  await host.call("fold", firstInput, "f1")
  await host.request(continuation(["f1"]))
  expect(host.events).toEqual([])
})

test("fold activation notifications accept a custom duration", async () => {
  const host = await harness(new Map(), { notifications: { duration: 7_500 } })
  await host.request()
  await host.call("fold", firstInput, "f1")
  await host.request(continuation(["f1"]))
  expect(host.events[0]).toEqual({
    name: "foldsActivated",
    data: expect.objectContaining({ count: 1, duration: 7_500 }),
  })
})

test("failed persistence does not publish a fold and the queue recovers", async () => {
  const host = await harness()
  await host.request()
  host.failWrites(true)
  await expect(host.call("fold", firstInput, "f1")).rejects.toThrow("storage failure")
  expect(host.storage.size).toBe(0)
  host.failWrites(false)
  const retry = await host.call("fold", firstInput, "f1")
  expect(JSON.parse(retry.content as string).id).toBeTruthy()
})

test("overlapping parallel requests return a conflict without losing the first fold", async () => {
  const host = await harness()
  await host.request()
  const [first, second] = await Promise.all([
    host.call("fold", firstInput, "f1"),
    host.call("fold", { ...firstInput, summary: "Conflicting finding." }, "f2"),
  ])
  expect(JSON.parse(first.content as string).id).toBeTruthy()
  expect(JSON.parse(second.content as string).error).toContain("no longer visible")
  expect((host.storage.get("sessions/s1") as { folds: unknown[] }).folds).toHaveLength(1)
})

test("expansion lifetime persists across plugin reloads", async () => {
  const host = await harness()
  await host.request()
  const folded = await host.call("fold", firstInput, "f1")
  const id = JSON.parse(folded.content as string).id
  const expanded = await host.call("peek", { id }, "e1")
  const messages = [
    ...original(),
    Message.make({
      id: "peek-result",
      role: "tool",
      content: [
        { type: "tool-result", id: "e1", name: "peek", result: { type: "text", value: expanded.content } },
      ],
    }),
  ]
  const reloaded = await harness(host.storage)
  expect(JSON.stringify((await reloaded.request(messages)).messages)).toContain("historical content")
  messages.push(Message.make({ id: "u2", role: "user", content: "Next question" }))
  reloaded.finish()
  const next = await reloaded.request(messages)
  expect(JSON.stringify(next.messages)).toContain("call peek again")
  expect(JSON.stringify(next.messages)).not.toContain("historical content")
})

test("compaction without a fold receipt leaves it queued; active folds remain summarized", async () => {
  const host = await harness()
  await host.request()
  const folded = await host.call("fold", firstInput, "f1")
  const id = JSON.parse(folded.content as string).id
  const pending = await host.request(original(), "s1", "compaction")
  expect(JSON.stringify(pending.messages)).toContain("First episode begins")
  host.finish()
  await host.request(nextMessages())
  const event = await host.request(nextMessages(), "s1", "compaction")
  expect(JSON.stringify(event.messages)).toContain(id)
  expect(JSON.stringify(event.messages)).not.toContain("First episode begins")
  expect(event.system[0].text).toContain("copying IDs exactly")
})

test("compaction activates a queued fold when its tool result is present", async () => {
  const host = await harness()
  await host.request()
  const folded = JSON.parse((await host.call("fold", firstInput, "f1")).content as string)

  const event = await host.request(continuation(["f1"]), "s1", "compaction")
  const output = JSON.stringify(event.messages)
  expect(output).toContain(folded.id)
  expect(output).not.toContain("First episode begins")
  expect(event.system[0].text).toContain("copying IDs exactly")
  expect((host.storage.get("sessions/s1") as { folds: { status: string }[] }).folds[0].status).toBe("active")
})

test("bad anchors fail immediately and can be corrected without waiting a turn", async () => {
  const host = await harness()
  await host.request()
  expect(
    JSON.parse((await host.call("fold", { ...firstInput, start: "missing anchor" }, "bad")).content as string)
      .error,
  ).toContain("not found")
  expect(host.storage.size).toBe(0)
  const valid = JSON.parse((await host.call("fold", firstInput, "good")).content as string)
  expect(valid).toMatchObject({ status: "pending", applies: "next_model_request" })
  expect(JSON.stringify((await host.request()).messages)).toContain(prose)
})

test("pending overlaps are still reserved across tool-driven continuations", async () => {
  const host = await harness()
  await host.request()
  await host.call("fold", firstInput, "f1")
  await host.request()
  const conflict = await host.call("fold", { ...firstInput, summary: "Another summary" }, "f2")
  expect(JSON.parse(conflict.content as string).error).toContain("no longer visible")
})

test("steering and unfinished responses cannot activate a fold", async () => {
  const host = await harness()
  await host.request()
  await host.call("fold", firstInput, "f1")
  host.history([
    { type: "user", id: "u1" },
    { type: "assistant", id: "current", finish: "tool-calls", time: { completed: 1 } },
    { type: "user", id: "u2" },
  ])
  expect(JSON.stringify((await host.request(nextMessages())).messages)).toContain(prose)
  host.history([
    { type: "user", id: "u1" },
    { type: "assistant", id: "current", finish: "stop" },
    { type: "user", id: "u2" },
  ])
  expect(JSON.stringify((await host.request(nextMessages())).messages)).toContain(prose)
  host.finish()
  expect(JSON.stringify((await host.request(nextMessages())).messages)).not.toContain("First episode begins")
})

test("activation failure leaves original text and provides a persistent notice", async () => {
  const host = await harness()
  await host.request()
  await host.call("fold", firstInput, "f1")
  host.finish()
  const changed = [
    original()[0],
    Message.make({ id: "a1", role: "assistant", content: "Edited historical text" }),
    nextMessages()[2],
  ]
  expect(JSON.stringify((await host.request(changed)).messages)).toContain("Edited historical text")
  expect(host.notices).toHaveLength(1)
  expect(host.events).toHaveLength(0)
  expect(host.notices[0]).toContain("not applied")
  await host.request(changed)
  expect(host.notices).toHaveLength(1)
})

test("activation persists before changing the outgoing history; storage failure serves the previous view", async () => {
  const host = await harness()
  await host.request()
  await host.call("fold", firstInput, "f1")
  host.finish()
  host.failWrites(true)
  const degraded = await host.request(nextMessages())
  expect(JSON.stringify(degraded.messages)).toContain("First episode begins")
  expect(host.notices).toHaveLength(0)
  expect(host.events).toHaveLength(0)
  host.failWrites(false)
  expect(JSON.stringify((await host.request(nextMessages())).messages)).not.toContain("First episode begins")
  expect(host.events).toHaveLength(1)
})

test("pending peek returns captured media via ordinary tool file content", async () => {
  const host = await harness()
  const messages = [
    original()[0],
    Message.assistant("Media episode starts."),
    Message.user([{ type: "media", mediaType: "image/png", data: "iVBORw==", filename: "screen.png" }]),
    Message.assistant("Media episode ends."),
  ]
  await host.request(messages)
  const folded = JSON.parse(
    (
      await host.call(
        "fold",
        { start: "Media episode starts.", end: "Media episode ends.", summary: "Screenshot reviewed." },
        "media-fold",
      )
    ).content as string,
  )
  expect(folded.status).toBe("pending")
  const peeked = await host.call("peek", { id: folded.id }, "media-peek")
  expect(peeked.content).toContainEqual({
    type: "file",
    uri: "data:image/png;base64,iVBORw==",
    mime: "image/png",
    name: "screen.png",
  })
  expect(JSON.stringify((await host.request(messages)).messages)).toContain('"type":"media"')
})
