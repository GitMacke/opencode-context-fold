import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import tui, { activationMessage } from "./tui"

test("activation messages format single and batched reductions", () => {
  expect(
    activationMessage({
      sessionID: "s1",
      count: 1,
      removedChars: 18_422,
      beforeChars: 149_772,
      duration: 4_000,
    }),
  ).toBe("Reduced context by 18.4k characters (12.3%)")
  expect(
    activationMessage({
      sessionID: "s1",
      count: 2,
      removedChars: 36_844,
      beforeChars: 169_788,
      duration: 4_000,
    }),
  ).toBe("2 folds reduced context by 36.8k characters (21.7%)")
})

test("the TUI companion turns activation events into success toasts and unsubscribes", () => {
  let listener: ((event: { data: unknown }) => void) | undefined
  let unsubscribed = false
  const toasts: unknown[] = []
  const cleanup = tui.setup({
    client: {
      rpc: () => ({
        events: {
          on: (_name: string, callback: (event: { data: unknown }) => void) => {
            listener = callback
            return () => {
              unsubscribed = true
            }
          },
        },
      }),
    },
    ui: { toast: { show: (toast: unknown) => toasts.push(toast) } },
  } as unknown as Context)

  listener?.({
    data: { sessionID: "s1", count: 1, removedChars: 18_422, beforeChars: 149_772, duration: 7_500 },
  })
  expect(toasts).toEqual([
    {
      title: "Context folded",
      message: "Reduced context by 18.4k characters (12.3%)",
      variant: "success",
      duration: 7_500,
    },
  ])
  if (typeof cleanup === "function") cleanup()
  expect(unsubscribed).toBe(true)
})
