/** Только модель визуального прототипа. Не читает файлы и не вызывает OpenCode. */
export const STATUS_LABELS = {
  open: 'Open',
  done: 'Done',
  postponed: 'Deferred',
  dropped: 'Dropped',
} as const

export type Status = keyof typeof STATUS_LABELS
export type Filter = 'active' | 'all' | 'decisions'

export interface UserEdit {
  readonly text: string
  readonly status: Status
  readonly clarification: string
}

export interface Entry {
  readonly id: string
  readonly text: string
  readonly status: Status
  readonly why: readonly string[]
  readonly decided: readonly string[]
  readonly prompt?: string
  readonly reverted?: boolean
  readonly edits: readonly UserEdit[]
  readonly revision: number
}

export function selectEntries(entries: readonly Entry[], filter: Filter, query: string): Entry[] {
  const needle = query.trim().toLocaleLowerCase('ru')
  return entries.filter((entry) => {
    if (filter === 'active' && entry.status !== 'open') return false
    if (filter === 'decisions' && entry.decided.length === 0) return false
    return [entry.id, entry.text, ...entry.why, ...entry.decided, entry.prompt ?? '', ...entry.edits.map((edit) => edit.clarification)]
      .some((text) => text.toLocaleLowerCase('ru').includes(needle))
  }).sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open'))
}

/** Имитирует optimistic concurrency для UX конфликта, не реализация серверной записи. */
export function applyDemoEdit(entry: Entry, expectedRevision: number, edit: UserEdit): Entry {
  if (entry.revision !== expectedRevision) throw new Error('This entry has changed. Review the current version before saving. Your draft is still in the form.')
  if (entry.reverted) throw new Error('Reverted entries are read-only.')
  if (edit.text.trim() === '') throw new Error('Enter a summary.')
  if (!Object.hasOwn(STATUS_LABELS, edit.status)) throw new Error('Unknown status.')
  return {
    ...entry,
    text: edit.text.trim(),
    status: edit.status,
    revision: entry.revision + 1,
    edits: [...entry.edits, { ...edit, text: edit.text.trim(), clarification: edit.clarification.trim() }],
  }
}
