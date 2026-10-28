import type { Plugin } from '@opencode/plugin'
import { Journal, JournalEditError } from './journal.mjs'
import { memoryApi } from './memory-api.mjs'
import { Memory } from './rpc'

type Context = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]['setup']>>[0]

export async function registerMemory(ctx: Context, journal: Journal, log: (line: string) => Promise<unknown>) {
  const api = memoryApi(journal)
  type ErrorCode = keyof typeof Memory.methods.edit.errors
  type CallContext = { error: (type: ErrorCode, message: string, data: object) => unknown }

  async function invoke(method: string, input: { sessionID: string }, context: CallContext, action: () => Promise<unknown>) {
    const { sessionID } = input
    try {
      const session = await ctx.session.get({ sessionID })
      if (session.parentID !== undefined) return context.error('unavailable', 'Memory is unavailable in child sessions.', {})
      if (session.location.directory !== ctx.location.directory) return context.error('unavailable', 'Session location changed. Reopen memory in that session.', {})
      return await action()
    } catch (error) {
      if (error instanceof JournalEditError) return context.error(error.code, error.message, {})
      await log(`ERROR memory.${method} session=${sessionID}: ${error instanceof Error ? error.stack : String(error)}`)
      return context.error('unavailable', 'Could not access session memory. Your changes were not applied. Try again.', {})
    }
  }

  const registration = await ctx.rpc.register(Memory, {
    list: async (input, context) => {
      return invoke('list', input, context, () => api.list(input))
    },
    prompt: async (input, context) => {
      return invoke('prompt', input, context, () => api.prompt(input))
    },
    edit: async (input, context) => {
      return invoke('edit', input, context, async () => {
        const entry = await api.edit(input)
        // Сохранение уже состоялось. Сбой live-уведомления не превращает его в ложный отказ записи.
        void registration.events.emit('updated', { sessionID: input.sessionID }).catch((error: unknown) =>
          log(`ERROR memory.notify session=${input.sessionID}: ${error instanceof Error ? error.stack : String(error)}`))
        return entry
      })
    },
  })
  return registration
}
