import { Plugin } from "@opencode/plugin/tui"
import { ContextFoldRpc } from "./rpc"

interface FoldActivation {
  sessionID: string
  count: number
  removedChars: number
  beforeChars: number
  duration: number
}

function compact(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}k`
  return `${Number((value / 1_000_000).toFixed(1))}m`
}

export function activationMessage(event: FoldActivation): string {
  const subject = event.count === 1 ? "Reduced" : `${event.count} folds reduced`
  const percent = event.beforeChars
    ? Math.min(100, (event.removedChars / event.beforeChars) * 100).toFixed(1)
    : "0.0"
  return `${subject} context by ${compact(event.removedChars)} characters (${percent}%)`
}

export default Plugin.define({
  id: "context-fold.tui",
  setup(context) {
    const rpc = context.client.rpc(ContextFoldRpc)
    return rpc.events.on("foldsActivated", (event) => {
      const data = event.data as unknown as FoldActivation
      context.ui.toast.show({
        title: "Context folded",
        message: activationMessage(data),
        variant: "success",
        duration: data.duration,
      })
    })
  },
})
