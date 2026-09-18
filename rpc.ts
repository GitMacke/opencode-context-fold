import { Rpc } from "@opencode/plugin/rpc"

export const ContextFoldRpc = Rpc.define({
  id: "context-fold",
  methods: {},
  events: {
    foldsActivated: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          count: { type: "integer", minimum: 1 },
          removedChars: { type: "integer", minimum: 0 },
          beforeChars: { type: "integer", minimum: 0 },
          duration: { type: "integer", minimum: 1 },
        },
        required: ["sessionID", "count", "removedChars", "beforeChars", "duration"],
        additionalProperties: false,
      },
    },
  },
})
