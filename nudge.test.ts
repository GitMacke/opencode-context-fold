import { expect, test } from "bun:test"
import { type NudgeState, nudge } from "./nudge"
import { softNudge, strongNudge } from "./prompts"

const model = { providerID: "test", id: "test" }
const usage = (id: string, input: number) => ({
  id,
  type: "assistant",
  model,
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

test("pressure uses reported tokens including cache, output, and reasoning", () => {
  expect(nudge({}, [usage("1", 59_999)], model, 100_000, false)).toBeUndefined()
  expect(nudge({}, [usage("1", 60_000)], model, 100_000, false)).toBe(softNudge)
  expect(nudge({}, [usage("1", 80_000)], model, 100_000, false)).toBe(strongNudge)
  const cached = {
    ...usage("1", 0),
    tokens: { input: 1_000, output: 2_000, reasoning: 3_000, cache: { read: 70_000, write: 4_000 } },
  }
  expect(nudge({}, [cached], model, 100_000, false)).toBe(strongNudge)
})

test("cooldown counts fresh responses, allows escalation, and resets at low pressure", () => {
  const state: NudgeState = {}
  expect(nudge(state, [usage("1", 60_000)], model, 100_000, false)).toBe(softNudge)
  expect(nudge(state, [usage("1", 60_000)], model, 100_000, false)).toBeUndefined()
  expect(nudge(state, [usage("2", 80_000)], model, 100_000, false)).toBe(strongNudge)
  for (let i = 3; i <= 6; i++) {
    expect(nudge(state, [usage(String(i), 80_000)], model, 100_000, false)).toBeUndefined()
  }
  expect(nudge(state, [usage("7", 80_000)], model, 100_000, false)).toBe(strongNudge)
  expect(nudge(state, [usage("8", 20_000)], model, 100_000, false)).toBeUndefined()
  expect(nudge(state, [usage("9", 60_000)], model, 100_000, false)).toBe(softNudge)
})

test("folding blocks stale usage and grants cooldown even if pressure escalates", () => {
  const state: NudgeState = {}
  nudge(state, [usage("1", 60_000)], model, 100_000, false)
  expect(nudge(state, [usage("2", 90_000)], model, 100_000, true)).toBeUndefined()
  expect(nudge(state, [usage("2", 90_000)], model, 100_000, false)).toBeUndefined()
  for (let i = 3; i <= 6; i++) {
    expect(nudge(state, [usage(String(i), 90_000)], model, 100_000, false)).toBeUndefined()
  }
  expect(nudge(state, [usage("7", 90_000)], model, 100_000, false)).toBe(strongNudge)
})

test("missing, invalid, foreign-model, and pre-checkpoint usage cannot trigger reminders", () => {
  expect(nudge({}, [], model, 100_000, false)).toBeUndefined()
  for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(nudge({}, [usage("1", 90_000)], model, limit, false)).toBeUndefined()
  }
  expect(nudge({}, [usage("1", Number.NaN)], model, 100_000, false)).toBeUndefined()
  for (const other of [
    { ...model, id: "other" },
    { ...model, providerID: "other" },
  ]) {
    expect(nudge({}, [usage("1", 90_000)], other, 100_000, false)).toBeUndefined()
  }
  for (const type of ["compaction", "model-switched"]) {
    const history = [usage("1", 90_000), { id: "boundary", type }]
    expect(nudge({}, history, model, 100_000, false)).toBeUndefined()
    expect(nudge({}, [...history, usage("2", 60_000)], model, 100_000, false)).toBe(softNudge)
  }
})
