import { Rpc } from '@opencode/plugin/rpc'

export type Status = 'open' | 'done' | 'postponed' | 'dropped'
export type Filter = 'open' | 'all' | 'decisions'
export interface UserEdit {
  id: string
  at: string
  text: string
  status: Status
  clarification: string
}
export interface MemoryEntry {
  id: string
  text: string
  status: Status
  why: string[]
  decided: string[]
  hasPrompt: boolean
  reverted: boolean
  edits: UserEdit[]
  revision: string
}
export interface MemoryNote {
  id: string
  at: string | null
  kind: 'blocker' | 'dropped' | 'postponed'
  text: string
}
export interface MemoryUsage {
  writes: number
  served: number
  restores: number
  summaries: number
  pressures: number
  userEdits: number
  lastWriteAt: string | null
  lastServedAt: string | null
}
export interface MemoryStats {
  usage: MemoryUsage
  entries: { open: number; all: number; decisions: number; pending: number; reverted: number }
  notes: number
}
export interface MemorySnapshot {
  entries: MemoryEntry[]
  notes: MemoryNote[]
  counts: Record<Filter, number>
}
export interface EditInput {
  sessionID: string
  id: string
  revision: string
  text: string
  status: Status
  clarification: string
}

// JSON Schema в SDK 2.2.0 удаляет лишние поля вместо отказа и запрещает pattern.
// Standard Schema сохраняет строгую границу без зависимости от настроек декодера хоста.
function strictInput<T>(fields: Record<keyof T, (value: unknown) => boolean>) {
  return {
    '~standard': {
      version: 1 as const, vendor: 'session-checkpoint',
      types: undefined as { input: T; output: T } | undefined,
      validate(value: unknown) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected an object.' }] }
        const record = value as Record<string, unknown>
        const unexpected = Object.keys(record).find((key) => !Object.hasOwn(fields, key))
        if (unexpected !== undefined) return { issues: [{ message: 'Unknown field.', path: [unexpected] }] }
        for (const key of Object.keys(fields) as (keyof T & string)[]) {
          if (!Object.hasOwn(record, key) || !fields[key](record[key])) return { issues: [{ message: 'Invalid or missing field.', path: [key] }] }
        }
        return { value: value as T }
      },
    },
  }
}

const isSessionID = (value: unknown) => typeof value === 'string' && value.length <= 256 && /^ses_[a-zA-Z0-9]+$/.test(value)
const isEntryID = (value: unknown) => typeof value === 'string' && value.length <= 64 && /^i[0-9]+$/.test(value)
const isNoteID = (value: unknown) => typeof value === 'string' && value.length >= 1 && value.length <= 256
const isRevision = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isStatus = (value: unknown) => value === 'open' || value === 'done' || value === 'postponed' || value === 'dropped'

const text = { type: 'string' } as const
const lines = { type: 'array', items: text } as const
const sessionID = { type: 'string', minLength: 5, maxLength: 256 } as const
const id = { type: 'string', minLength: 2, maxLength: 64 } as const
const status = { type: 'string', enum: ['open', 'done', 'postponed', 'dropped'] } as const
const revision = { type: 'string', minLength: 64, maxLength: 64 } as const
const userEdit = {
  type: 'object',
  properties: { id: text, at: text, text, status, clarification: text },
  required: ['id', 'at', 'text', 'status', 'clarification'], additionalProperties: false,
} as const
const note = {
  type: 'object',
  properties: {
    id: text, at: { type: ['string', 'null'] },
    kind: { type: 'string', enum: ['blocker', 'dropped', 'postponed'] }, text,
  },
  required: ['id', 'at', 'kind', 'text'], additionalProperties: false,
} as const
const usage = {
  type: 'object',
  properties: {
    writes: { type: 'integer' }, served: { type: 'integer' }, restores: { type: 'integer' },
    summaries: { type: 'integer' }, pressures: { type: 'integer' }, userEdits: { type: 'integer' },
    lastWriteAt: { type: ['string', 'null'] }, lastServedAt: { type: ['string', 'null'] },
  },
  required: ['writes', 'served', 'restores', 'summaries', 'pressures', 'userEdits', 'lastWriteAt', 'lastServedAt'],
  additionalProperties: false,
} as const
const stats = {
  type: 'object',
  properties: {
    usage,
    entries: {
      type: 'object',
      properties: {
        open: { type: 'integer' }, all: { type: 'integer' }, decisions: { type: 'integer' },
        pending: { type: 'integer' }, reverted: { type: 'integer' },
      },
      required: ['open', 'all', 'decisions', 'pending', 'reverted'], additionalProperties: false,
    },
    notes: { type: 'integer' },
  },
  required: ['usage', 'entries', 'notes'], additionalProperties: false,
} as const
const entry = {
  type: 'object',
  properties: {
    id, text, status, why: lines, decided: lines,
    hasPrompt: { type: 'boolean' }, reverted: { type: 'boolean' },
    edits: { type: 'array', items: userEdit }, revision,
  },
  required: ['id', 'text', 'status', 'why', 'decided', 'hasPrompt', 'reverted', 'edits', 'revision'],
  additionalProperties: false,
} as const
const errors = {
  conflict: { type: 'object', additionalProperties: false },
  read_only: { type: 'object', additionalProperties: false },
  not_found: { type: 'object', additionalProperties: false },
  invalid_edit: { type: 'object', additionalProperties: false },
  unavailable: { type: 'object', additionalProperties: false },
} as const

export const Memory = Rpc.define({
  id: 'local-session-checkpoint.memory',
  methods: {
    list: {
      input: strictInput<{ sessionID: string; query: string; filter: Filter }>({
        sessionID: isSessionID,
        query: (value) => typeof value === 'string' && value.length <= 256,
        filter: (value) => value === 'open' || value === 'all' || value === 'decisions',
      }),
      output: {
        type: 'object', properties: {
          entries: { type: 'array', items: entry },
          notes: { type: 'array', items: note },
          counts: { type: 'object', properties: { open: { type: 'integer' }, all: { type: 'integer' }, decisions: { type: 'integer' } }, required: ['open', 'all', 'decisions'], additionalProperties: false },
        }, required: ['entries', 'notes', 'counts'], additionalProperties: false,
      }, errors,
    },
    prompt: {
      input: strictInput<{ sessionID: string; id: string }>({ sessionID: isSessionID, id: isEntryID }),
      output: { type: 'object', properties: { text }, required: ['text'], additionalProperties: false }, errors,
    },
    edit: {
      input: strictInput<EditInput>({
        sessionID: isSessionID, id: isEntryID, revision: isRevision, status: isStatus,
        text: (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000,
        clarification: (value) => typeof value === 'string' && value.length <= 4000,
      }),
      output: entry, errors,
    },
    dismiss: {
      input: strictInput<{ sessionID: string; id: string }>({ sessionID: isSessionID, id: isNoteID }),
      output: { type: 'object', properties: { notes: { type: 'array', items: note } }, required: ['notes'], additionalProperties: false }, errors,
    },
    stats: {
      input: strictInput<{ sessionID: string }>({ sessionID: isSessionID }),
      output: stats, errors,
    },
  },
  events: { updated: { schema: { type: 'object', properties: { sessionID }, required: ['sessionID'], additionalProperties: false } } },
})
