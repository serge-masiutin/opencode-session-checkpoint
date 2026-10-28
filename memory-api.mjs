import { entryRevision } from './journal.mjs'

export function presentEntry(entry) {
  return {
    id: entry.id, text: entry.text, status: entry.status,
    why: entry.why, decided: entry.decided,
    hasPrompt: entry.prompt !== undefined, reverted: entry.reverted === true,
    edits: entry.userEdits ?? [], revision: entryRevision(entry),
  }
}

/** RPC читает и пишет через тот же Journal, что и инструменты модели. */
export function memoryApi(journal) {
  return {
    async list({ sessionID, query, filter }) {
      const state = await journal.inspect(sessionID)
      const needle = query.trim().toLowerCase()
      const entries = []
      for (const entry of state.entries) {
        if (filter === 'open' && entry.status !== 'open') continue
        if (filter === 'decisions' && entry.decided.length === 0) continue
        const summary = [entry.id, entry.text, ...entry.why, ...entry.decided, ...(entry.userEdits ?? []).map((edit) => edit.clarification)].join('\n')
        if (needle !== '' && !summary.toLowerCase().includes(needle)) {
          if (entry.prompt === undefined || !(await journal.readPrompt(sessionID, entry.id)).toLowerCase().includes(needle)) continue
        }
        entries.push(presentEntry(entry))
      }
      entries.sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open'))
      return {
        entries,
        notes: state.notes.filter((note) => note.text.toLowerCase().includes(needle)),
        counts: {
          open: state.entries.filter((entry) => entry.status === 'open').length,
          all: state.entries.length,
          decisions: state.entries.filter((entry) => entry.decided.length > 0).length,
        },
      }
    },
    async prompt({ sessionID, id }) {
      const state = await journal.inspect(sessionID)
      if (!state.entries.some((entry) => entry.id === id && entry.prompt !== undefined)) throw new Error('No linked prompt.')
      return { text: await journal.readPrompt(sessionID, id) }
    },
    async edit({ sessionID, id, revision, ...change }) {
      return presentEntry(await journal.edit(sessionID, id, revision, change))
    },
  }
}
