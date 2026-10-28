import { Plugin } from "@opencode/plugin"
import { setup } from "./runtime.mjs"
import { registerMemory } from "./memory-rpc"
import type { Journal } from "./journal.mjs"

export default Plugin.define({
  id: "local-session-checkpoint",
  setup: (ctx) => setup(ctx, undefined, (journal: Journal, log: (line: string) => Promise<void>) => registerMemory(ctx, journal, log)),
})
