import { describe, expect, test } from "bun:test"
import { type ContentPart, Message } from "@opencode/ai"
import { applyFold, createView, type Fold, FoldError, prepareFold, render } from "./core"

const prose =
  "Investigation begins here. " +
  "Details from the completed investigation. ".repeat(20) +
  "Investigation finishes here."
const message = (id: string, role: "user" | "assistant" | "tool", content: ContentPart[]) =>
  Message.make({ id, role, content })
const text = (id: string, value: string) => message(id, "assistant", [{ type: "text", text: value }])
const flatten = (messages: Message[]) => JSON.stringify(messages.map((message) => message.content))
const input = {
  start: "Investigation begins here.",
  end: "Investigation finishes here.",
  summary: "Found the relevant change.",
}

function replay(
  messages: readonly Message[],
  folds: Fold[],
): { view: ReturnType<typeof createView>; skipped: string[] } {
  let view = createView(messages)
  const skipped: string[] = []
  for (const fold of folds) {
    try {
      view = applyFold(view, fold)
    } catch (error) {
      if (!(error instanceof FoldError)) throw error
      skipped.push(fold.id)
    }
  }
  return { view, skipped }
}

describe("fold addressing and replay", () => {
  test("partial fold preserves prefix, suffix, role, and original history", () => {
    const messages = [text("m1", `PREFIX ${prose} SUFFIX`)]
    const before = JSON.stringify(messages)
    const view = createView(messages)
    const fold = prepareFold(view, input)
    expect(fold.id).toMatch(/^[A-Za-z0-9_-]{6}$/)
    const result = render(applyFold(view, fold))
    expect(result[0].role).toBe("assistant")
    expect(flatten(result)).toContain(`PREFIX [folded ${fold.id}]`)
    expect(flatten(result)).toContain("[/folded] SUFFIX")
    expect(JSON.stringify(messages)).toBe(before)
    expect(fold.original).toContain(prose)
    expect(flatten(render(replay(messages, [fold]).view))).toBe(flatten(result))
  })

  test("ambiguity gives useful errors and anchors match exactly", () => {
    expect(() => prepareFold(createView([text("a", prose), text("b", prose)]), input)).toThrow("2 matches")
    const view = createView([text("a", prose.replace("begins here", "begins\n   here"))])
    expect(() => prepareFold(view, input)).toThrow("not found")
    const fold = prepareFold(view, { ...input, start: "Investigation begins\n   here." })
    expect(flatten(render(applyFold(view, fold)))).not.toContain("Investigation finishes")
    expect(() => prepareFold(view, { ...input, start: "does not exist at all" })).toThrow("not found")
    expect(() =>
      prepareFold(createView([text("a", prose)]), { ...input, start: input.end, end: input.start }),
    ).toThrow("end must follow")
  })

  test("short anchors are fine when unique; whitespace-only anchors are rejected", () => {
    const view = createView([text("a", `<<${prose}>>`)])
    const fold = prepareFold(view, { ...input, start: "<<", end: ">>" })
    expect(flatten(render(applyFold(view, fold)))).toBe(
      JSON.stringify([[{ type: "text", text: `[folded ${fold.id}] ${input.summary} [/folded]` }]]),
    )
    expect(() => prepareFold(view, { ...input, start: "   " })).toThrow("non-whitespace")
    expect(() => prepareFold(view, { ...input, start: "e" })).toThrow("matches")
  })

  test("disjoint parallel folds within the same part survive shifting offsets", () => {
    const other = prose.replaceAll("Investigation", "Secondary search")
    const view = createView([text("m1", `${prose}\n${other}`)])
    const first = prepareFold(view, input)
    const second = prepareFold(view, {
      start: "Secondary search begins here.",
      end: "Secondary search finishes here.",
      summary: "Second finding.",
    })
    const forward = render(applyFold(applyFold(view, first), second))
    const reverse = render(applyFold(applyFold(view, second), first))
    expect(flatten(forward)).toBe(flatten(reverse))
    expect(flatten(forward)).toContain(first.id)
    expect(flatten(forward)).toContain(second.id)
  })

  test("overlapping folds cannot silently overwrite one another", () => {
    const view = createView([text("m1", prose)])
    const first = prepareFold(view, input)
    const second = prepareFold(view, { ...input, summary: "Another summary." })
    expect(() => applyFold(applyFold(view, first), second)).toThrow("no longer visible")
  })

  test("nested fold archives the inner marker, not its hidden content", () => {
    const messages = [
      text("a", `Outer episode starts. ${prose} ${"Additional findings. ".repeat(30)} Outer episode ends.`),
    ]
    const first = prepareFold(createView(messages), input)
    const afterFirst = applyFold(createView(messages), first)
    const outer = prepareFold(afterFirst, {
      start: "Outer episode starts.",
      end: "Outer episode ends.",
      summary: "All findings consolidated.",
    })
    const result = render(replay(messages, [first, outer]).view)
    expect(flatten(result)).toContain(outer.id)
    expect(flatten(result)).not.toContain(first.id)
    expect(outer.original).toContain(`[folded ${first.id}]`)
    expect(outer.original).not.toContain("Details from the completed")
    expect(first.original).toContain("Details from the completed")
  })

  test("appended duplicate quotes do not change saved addressing", () => {
    const original = [text("a", prose)]
    const fold = prepareFold(createView(original), input)
    const result = replay([...original, text("b", prose)], [fold])
    expect(result.skipped).toEqual([])
    expect(render(result.view)[1].content).toEqual(original[0].content)
  })

  test("checkpoint/edited history skips stale folds without hiding new content", () => {
    const fold = prepareFold(createView([text("a", prose)]), input)
    const checkpoint = [text("checkpoint", prose)]
    expect(replay(checkpoint, [fold]).skipped).toEqual([fold.id])
    expect(render(replay(checkpoint, [fold]).view)).toEqual(checkpoint)
    const edited = [text("a", prose.replace("Details", "Changed"))]
    expect(replay(edited, [fold]).skipped).toEqual([fold.id])
  })

  test("idless messages replay conservatively", () => {
    const original = [Message.assistant(prose)]
    const fold = prepareFold(createView(original), input)
    const result = replay([...original, Message.user("Continue")], [fold])
    expect(result.skipped).toEqual([])
    expect(flatten(render(result.view))).toContain(fold.id)
  })

  test("summary must actually save space", () => {
    expect(() => prepareFold(createView([text("a", prose)]), { ...input, summary: prose + prose })).toThrow(
      "not shorter",
    )
  })

  test("folds survive a provider switch that drops foreign reasoning and changes metadata", () => {
    const onBedrock = [
      message("a", "assistant", [
        { type: "reasoning", text: "", providerMetadata: { bedrock: { signature: "sig" } } },
        { type: "text", text: `Intro. ${prose}`, providerMetadata: { bedrock: { x: 1 } } },
      ]),
      message("b", "assistant", [
        { type: "reasoning", text: "", providerMetadata: { bedrock: { signature: "sig2" } } },
        { type: "text", text: "Tail." },
      ]),
    ]
    const onCopilot = [
      message("a", "assistant", [
        { type: "text", text: `Intro. ${prose}`, providerMetadata: { openai: { itemId: "i1" } } },
      ]),
      message("b", "assistant", [{ type: "text", text: "Tail." }]),
    ]
    const fold = prepareFold(createView(onCopilot), input)
    const back = replay(onBedrock, [fold])
    expect(back.skipped).toEqual([])
    expect(flatten(render(back.view))).toContain(fold.id)
    const forward = replay(onCopilot, [prepareFold(createView(onBedrock), input)])
    expect(forward.skipped).toEqual([])
  })
})

describe("structured history", () => {
  const call = (id: string) =>
    message(`call-${id}`, "assistant", [
      { type: "tool-call", id, name: "shell", input: { command: "git log" } },
    ])
  const result = (id: string, value: string) =>
    message(`result-${id}`, "tool", [
      { type: "tool-result", id, name: "shell", result: { type: "text", value } },
    ])

  test("result-only fold retains the call and result ID", () => {
    const messages = [call("c1"), result("c1", prose)]
    const fold = prepareFold(createView(messages), input)
    const output = render(replay(messages, [fold]).view)
    expect(output[0]).toBe(messages[0])
    expect(output[1].content[0]).toMatchObject({ type: "tool-result", id: "c1" })
    expect(flatten(output)).toContain(fold.id)
  })

  test("complete multi-tool episode removes pairs, preserving following conversation", () => {
    const messages = [
      text("start", "Episode starts here."),
      call("c1"),
      result("c1", prose),
      call("c2"),
      result("c2", prose),
      text("end", "Episode ends here."),
      Message.user("What next?"),
    ]
    const fold = prepareFold(createView(messages), {
      start: "Episode starts here.",
      end: "Episode ends here.",
      summary: "Identified the commit.",
    })
    const output = render(replay(messages, [fold]).view)
    expect(output).toHaveLength(2)
    expect(output[0].content[0].type).toBe("text")
    expect(output[1].role).toBe("user")
    expect(fold.original).toContain("shell tool-call")
  })

  test("splitting a tool pair returns an error, not a malformed request", () => {
    const messages = [text("start", "Episode starts here."), call("c1"), result("c1", `${prose} more output`)]
    expect(() => prepareFold(createView(messages), { ...input, start: "Episode starts here." })).toThrow(
      "call/result pair",
    )
  })

  test("parallel results with calls outside the range retain all envelopes", () => {
    const messages = [
      call("c1"),
      call("c2"),
      result("c1", `First result begins. ${prose}`),
      result("c2", `${prose} Second result ends.`),
    ]
    const fold = prepareFold(createView(messages), {
      start: "First result begins.",
      end: "Second result ends.",
      summary: "Both searches found the commit.",
    })
    const output = render(replay(messages, [fold]).view)
    expect(output).toHaveLength(4)
    expect(output[3].content[0]).toMatchObject({
      type: "tool-result",
      id: "c2",
      result: { type: "text", value: "" },
    })
  })

  test("whole reasoning may be folded but is never returned by peek", () => {
    const messages = [
      text("a", "Episode starts here."),
      message("r", "assistant", [{ type: "reasoning", text: "PRIVATE", encrypted: "opaque" }]),
      text("b", prose),
    ]
    const fold = prepareFold(createView(messages), { ...input, start: "Episode starts here." })
    expect(fold.original).not.toContain("PRIVATE")
    expect(fold.original).not.toContain("opaque")
    expect(flatten(render(replay(messages, [fold]).view))).not.toContain("reasoning")
  })
})
