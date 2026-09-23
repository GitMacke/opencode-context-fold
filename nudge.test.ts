import { expect, test } from "bun:test"
import { type NudgeState, nudge } from "./nudge"
import { nudgeText } from "./prompts"

const model = { providerID: "test", id: "test" }
const usage = (id: string, input: number) => ({
  id,
  type: "assistant",
  model,
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

test("reminders fire each time context grows by the interval, counting cache, output, and reasoning", () => {
  const state: NudgeState = {}
  expect(nudge(state, [usage("1", 30_000)], model, 50_000, false)).toBeUndefined()
  expect(nudge(state, [usage("2", 79_999)], model, 50_000, false)).toBeUndefined()
  expect(nudge(state, [usage("3", 80_000)], model, 50_000, false)).toBe(nudgeText(50_000))
  // Repeated hooks for the same reading don't fire again.
  expect(nudge(state, [usage("3", 80_000)], model, 50_000, false)).toBeUndefined()
  expect(nudge(state, [usage("4", 120_000)], model, 50_000, false)).toBeUndefined()
  const cached = {
    ...usage("5", 0),
    tokens: { input: 1_000, output: 2_000, reasoning: 3_000, cache: { read: 120_000, write: 4_000 } },
  }
  expect(nudge(state, [cached], model, 50_000, false)).toBe(nudgeText(50_000))
})

test("folding ignores the stale reading and restarts the interval from the next one", () => {
  const state: NudgeState = {}
  nudge(state, [usage("1", 10_000)], model, 50_000, false)
  expect(nudge(state, [usage("2", 90_000)], model, 50_000, true)).toBeUndefined()
  expect(nudge(state, [usage("2", 90_000)], model, 50_000, false)).toBeUndefined()
  expect(nudge(state, [usage("3", 40_000)], model, 50_000, false)).toBeUndefined()
  expect(nudge(state, [usage("4", 89_999)], model, 50_000, false)).toBeUndefined()
  expect(nudge(state, [usage("5", 90_000)], model, 50_000, false)).toBe(nudgeText(50_000))
})

test("shrinking context and model switches restart the interval", () => {
  const state: NudgeState = {}
  nudge(state, [usage("1", 100_000)], model, 50_000, false)
  expect(nudge(state, [usage("2", 20_000)], model, 50_000, false)).toBeUndefined()
  expect(nudge(state, [usage("3", 70_000)], model, 50_000, false)).toBe(nudgeText(50_000))
  const other = { ...model, id: "other" }
  expect(nudge(state, [{ ...usage("4", 200_000), model: other }], other, 50_000, false)).toBeUndefined()
  expect(nudge(state, [{ ...usage("5", 250_000), model: other }], other, 50_000, false)).toBe(
    nudgeText(50_000),
  )
})

test("missing, invalid, foreign-model, and pre-checkpoint usage cannot trigger reminders", () => {
  const primed = (): NudgeState => ({ baseline: 0, model: JSON.stringify(["test", "test", null]) })
  expect(nudge(primed(), [], model, 50_000, false)).toBeUndefined()
  for (const every of [0, -1, Number.NaN]) {
    expect(nudge(primed(), [usage("1", 90_000)], model, every, false)).toBeUndefined()
  }
  expect(nudge(primed(), [usage("1", Number.NaN)], model, 50_000, false)).toBeUndefined()
  for (const other of [
    { ...model, id: "other" },
    { ...model, providerID: "other" },
  ]) {
    expect(nudge(primed(), [usage("1", 90_000)], other, 50_000, false)).toBeUndefined()
  }
  for (const type of ["compaction", "model-switched"]) {
    const history = [usage("1", 90_000), { id: "boundary", type }]
    expect(nudge(primed(), history, model, 50_000, false)).toBeUndefined()
    expect(nudge(primed(), [...history, usage("2", 60_000)], model, 50_000, false)).toBe(nudgeText(60_000))
  }
})
