import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const POLICY = Object.freeze({
  // Мягкий порог: сначала напоминание модели, на следующем шаге — штатное сжатие. Ничего не блокируется.
  compactAt: 300_000,
  retentionDays: 15,
})

export const STATUSES = Object.freeze(['open', 'done', 'dropped', 'postponed'])
export const NOTE_KINDS = Object.freeze({ dropped: 'Dropped', postponed: 'Postponed', blocker: 'Блокер' })
const PENDING = '(ждёт сути)'

export function sessionDir(root, sessionID) {
  // ID приходит из OpenCode, но попадает в путь: не даём выйти за пределы каталога.
  if (!/^ses_[a-zA-Z0-9]+$/.test(sessionID)) throw new Error(`Некорректный ID сессии: ${sessionID}`)
  return join(root, sessionID)
}

async function writeAtomic(folder, name, text) {
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const temporary = join(folder, `.${name}-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, join(folder, name))
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * Журнал одной сессии: intent.json — источник правды, intent.md — его отображение для человека,
 * prompts/<id>.md — полный текст сообщений пользователя. Операции одной сессии выполняются по очереди.
 */
export class Journal {
  #queues = new Map()

  constructor(root, onError = async () => {}) {
    this.root = root
    this.onError = onError
  }

  #serial(sessionID, action) {
    const previous = this.#queues.get(sessionID) ?? Promise.resolve()
    const next = previous.then(action, action)
    this.#queues.set(sessionID, next.catch(() => {}))
    return next
  }

  /** Чтение без побочных эффектов; повреждённый журнал читается как пустой, исправляет его только очередь записи. */
  async load(sessionID) {
    const raw = await this.#read(sessionID)
    const state = (raw === undefined ? undefined : parseState(raw)) ?? emptyState(await this.#nextFreeID(sessionID))
    return visibleState(state)
  }

  /** Строгое чтение для GUI: ошибка чтения не должна выглядеть как пустая память. */
  async inspect(sessionID) {
    return visibleState(await this.#inspectAll(sessionID))
  }

  async #inspectAll(sessionID) {
    const raw = await this.#read(sessionID)
    if (raw === undefined) return emptyState(1)
    const state = parseState(raw)
    if (state === undefined) throw new Error('The journal is invalid. No changes were made.')
    return state
  }

  /** Пользовательская правка: проверка версии и запись проходят в одной очереди с инструментами модели. */
  edit(sessionID, id, expectedRevision, { text, status, clarification }) {
    return this.#serial(sessionID, async () => {
      const state = await this.#inspectAll(sessionID)
      const entry = state.entries.find((candidate) => candidate.id === id && candidate.delivered === true)
      if (entry === undefined) throw new JournalEditError('not_found', 'Entry not found.')
      if (entry.reverted === true) throw new JournalEditError('read_only', 'Reverted entries are read-only.')
      if (entryRevision(entry) !== expectedRevision) throw new JournalEditError('conflict', 'This entry changed. Review the current version; your draft has not been saved.')
      if (text.trim() === '') throw new JournalEditError('invalid_edit', 'Enter a summary.')
      if (!STATUSES.includes(status)) throw new JournalEditError('invalid_edit', 'Unknown status.')
      const correction = { id: randomUUID(), at: new Date().toISOString(), text: text.trim(), status, clarification: clarification.trim() }
      entry.text = correction.text
      entry.status = status
      entry.userEdits = [...(entry.userEdits ?? []), correction]
      touchWrite(state)
      state.usage.userEdits += 1
      await this.#save(sessionID, state)
      return entry
    })
  }

  async #read(sessionID) {
    try {
      return await readFile(join(sessionDir(this.root, sessionID), 'intent.json'), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }

  // После потери intent.json нумерация продолжается за уже сохранёнными prompts/iN.md, чтобы их не перезаписать.
  async #nextFreeID(sessionID) {
    try {
      const numbers = (await readdir(join(sessionDir(this.root, sessionID), 'prompts'))).map((name) => /^i(\d+)(?:-delivered)?\.md$/.exec(name)?.[1]).filter(Boolean).map(Number)
      return Math.max(0, ...numbers) + 1
    } catch (error) {
      if (error.code === 'ENOENT') return 1
      throw error
    }
  }

  async #loadForWrite(sessionID) {
    const raw = await this.#read(sessionID)
    if (raw === undefined) return emptyState(await this.#nextFreeID(sessionID))
    const state = parseState(raw)
    if (state !== undefined) return state
    const path = join(sessionDir(this.root, sessionID), 'intent.json')
    const aside = `${path}.corrupt-${Date.now()}`
    await rename(path, aside)
    await this.onError(`corrupt journal moved to ${aside}`)
    return emptyState(await this.#nextFreeID(sessionID))
  }

  async #save(sessionID, state) {
    const folder = sessionDir(this.root, sessionID)
    await writeAtomic(folder, 'intent.json', `${JSON.stringify(state, null, 2)}\n`)
    // intent.md — только отображение: его сбой не должен превращать сохранённую запись в ошибку для модели.
    await writeAtomic(folder, 'intent.md', render(visibleState(state), 'full')).catch((error) => this.onError(`intent.md: ${error.message}`))
  }

  /** Обновляет доступное модели представление только из подтверждённых записей. */
  syncView(sessionID) {
    return this.#serial(sessionID, async () => {
      if (await this.#read(sessionID) === undefined) return
      const state = await this.#inspectAll(sessionID)
      await writeAtomic(sessionDir(this.root, sessionID), 'intent.md', render(visibleState(state), 'full'))
    })
  }

  #mutate(sessionID, change) {
    return this.#serial(sessionID, async () => {
      const state = await this.#loadForWrite(sessionID)
      const result = await change(state)
      await this.#save(sessionID, state)
      return result
    })
  }

  /** Сохраняет сообщение пользователя целиком и ставит заготовку. Повтор того же messageID игнорируется. */
  recordPrompt(sessionID, messageID, text, revertTo) {
    return this.#serial(sessionID, async () => {
      const state = await this.#loadForWrite(sessionID)
      const existing = state.entries.find((entry) => entry.delivered === true && entry.messageID === messageID)
      if (existing !== undefined) return existing.id
      // OpenCode вызывает prompt hook до commit staged rewind. Сохраняем его точную границу,
      // но применяем только когда новое сообщение действительно появится в контексте модели.
      const boundary = revertTo === undefined ? -1 : state.entries.findIndex((entry) => entry.messageID === revertTo)
      if (revertTo !== undefined && boundary === -1) await this.onError(`rewind boundary absent from journal session=${sessionID} message=${revertTo}`)
      const reverts = boundary === -1 ? [] : state.entries.slice(boundary)
        .filter((entry) => entry.delivered === true && entry.messageID !== undefined && entry.reverted !== true).map((entry) => entry.id)
      const id = `i${state.next++}`
      await writeAtomic(join(sessionDir(this.root, sessionID), 'prompts'), `${id}.md`, text)
      state.entries.push({ id, text: PENDING, status: 'open', why: [], decided: [], messageID, delivered: true, prompt: `prompts/${id}.md`, ...(reverts.length === 0 ? {} : { reverts }) })
      touchWrite(state)
      await this.#save(sessionID, state)
      return id
    })
  }

  addIntent(sessionID, { text, why, decided }) {
    return this.#mutate(sessionID, (state) => {
      const id = `i${state.next++}`
      state.entries.push({ id, text, status: 'open', why: why === undefined ? [] : [why], decided: decided === undefined ? [] : [decided], delivered: true })
      touchWrite(state)
      return id
    })
  }

  addNote(sessionID, kind, text) {
    if (!Object.hasOwn(NOTE_KINDS, kind)) throw new Error(`Неизвестный вид записи: ${kind}; допустимо: intent, ${Object.keys(NOTE_KINDS).join(', ')}`)
    return this.#mutate(sessionID, (state) => {
      state.notes.push({ id: randomUUID(), at: new Date().toISOString(), kind, text, delivered: true })
      touchWrite(state)
    })
  }

  /** Удаление заметки уровня сессии из GUI; исходные промпты и выводы агента не трогает. */
  dismissNote(sessionID, id) {
    return this.#mutate(sessionID, (state) => {
      const index = state.notes.findIndex((note) => note.id === id && note.delivered === true)
      if (index === -1) throw new JournalEditError('not_found', 'Note not found.')
      state.notes.splice(index, 1)
      return state.notes.length
    })
  }

  /** Фиксирует факт выдачи журнала модели: обычный контекст, восстановление или сводка. */
  noteServed(sessionID, { restored = false, summarized = false, pressured = false } = {}) {
    return this.#mutate(sessionID, (state) => {
      const usage = usageOf(state)
      usage.served += 1
      if (restored) usage.restores += 1
      if (summarized) usage.summaries += 1
      if (pressured) usage.pressures += 1
      usage.lastServedAt = new Date().toISOString()
      state.usage = usage
    })
  }

  /** target: { id } — запись по ID; { messageID } — запись сообщения пользователя. Возвращает ID изменённой записи. */
  update(sessionID, target, { text, status, why, decided }) {
    if (status !== undefined && !STATUSES.includes(status)) throw new Error(`Неизвестный статус: ${status}; допустимо: ${STATUSES.join(', ')}`)
    return this.#mutate(sessionID, (state) => {
      const entry = target.id === undefined
        ? state.entries.find((candidate) => candidate.delivered === true && candidate.messageID === target.messageID)
        : state.entries.find((candidate) => candidate.delivered === true && candidate.id === target.id)
      if (entry === undefined) throw new Error(target.id === undefined ? 'Для сообщения, на которое ты отвечаешь, нет записи; укажи id' : `Запись ${target.id} не найдена; есть: ${visibleState(state).entries.map((candidate) => candidate.id).join(', ') || 'нет записей'}`)
      if (text !== undefined) entry.text = text
      if (status !== undefined) entry.status = status
      if (why !== undefined) entry.why.push(why)
      if (decided !== undefined) entry.decided.push(decided)
      touchWrite(state)
      return entry.id
    })
  }

  /** Закрывает записи откатанных сообщений. Возвращает их ID. */
  markReverted(sessionID, visibleMessageIDs, compacted) {
    return this.#mutate(sessionID, (state) => {
      const ids = revertedIDs(visibleState(state), visibleMessageIDs, compacted)
      for (const entry of state.entries.filter((candidate) => ids.includes(candidate.id))) {
        entry.status = 'dropped'
        entry.reverted = true
        entry.why.push(REVERTED_WHY)
      }
      if (ids.length > 0) touchWrite(state)
      return ids
    })
  }

  async readPrompt(sessionID, id) {
    if (!/^i\d+$/.test(id)) throw new Error(`Некорректный ID записи: ${id}`)
    const state = await this.inspect(sessionID)
    const entry = state.entries.find((candidate) => candidate.id === id && candidate.prompt !== undefined)
    if (entry === undefined) throw new Error(`У записи ${id} нет доступного сообщения`)
    if (entry.prompt !== `prompts/${id}.md`) throw new Error(`Некорректный путь сообщения записи ${id}`)
    try {
      return await readFile(join(sessionDir(this.root, sessionID), entry.prompt), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`У записи ${id} нет сохранённого сообщения`, { cause: error })
      throw error
    }
  }
}

// Старые записи без подтверждения могут относиться к недоставленной очереди.
function visibleState(state) {
  return { ...state, entries: state.entries.filter((entry) => entry.delivered === true), notes: state.notes.filter((note) => note.delivered === true) }
}

export function pendingIDs(state) {
  return state.entries.filter((entry) => entry.status === 'open' && entry.text === PENDING).map((entry) => entry.id)
}

/**
 * Сообщения пользователя, которые пропали из контекста между видимыми сообщениями, — откатанные.
 * Записи позже последнего видимого — ещё в очереди. Раньше первого видимого — откатаны, если сжатия не было,
 * иначе их не отличить от ушедших в сводку. Для новых сообщений reverts хранит точную
 * границу staged rewind: видимость этого сообщения подтверждает commit, независимо от сжатия.
 */
export function revertedIDs(state, visibleMessageIDs, compacted) {
  const visible = new Set(visibleMessageIDs)
  const positions = state.entries.flatMap((entry, index) => visible.has(entry.messageID) ? [index] : [])
  if (positions.length === 0) return []
  const confirmed = state.entries.filter((entry) => visible.has(entry.messageID)).flatMap((entry) => entry.reverts ?? [])
  const inferred = state.entries.slice(compacted ? positions[0] : 0, positions.at(-1))
    .filter((entry) => entry.messageID !== undefined && !visible.has(entry.messageID) && entry.reverted !== true)
    .map((entry) => entry.id)
  const ids = new Set([...confirmed, ...inferred])
  return state.entries.filter((entry) => ids.has(entry.id) && entry.reverted !== true).map((entry) => entry.id)
}

const REVERTED_WHY = 'Пользователь откатил это сообщение'
const emptyState = (next) => ({ next, entries: [], notes: [], usage: emptyUsage() })
const emptyUsage = () => ({ writes: 0, served: 0, restores: 0, summaries: 0, pressures: 0, userEdits: 0, lastWriteAt: null, lastServedAt: null })
function touchWrite(state) {
  const usage = usageOf(state)
  usage.writes += 1
  usage.lastWriteAt = new Date().toISOString()
  state.usage = usage
}

/** Счётчики использования журнала агентом; отсутствуют в старых файлах — считаются нулями. */
export function usageOf(state) {
  const usage = state.usage ?? {}
  return { ...emptyUsage(), ...usage }
}

export class JournalEditError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function entryRevision(entry) {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex')
}

/** Только последняя пользовательская правка каждой записи; откатанные сообщения не дают указаний. */
export function userCorrections(state) {
  return state.entries.filter((entry) => entry.reverted !== true && entry.userEdits?.length > 0)
    .map((entry) => ({ entryID: entry.id, ...entry.userEdits.at(-1) }))
}

function isNote(note) {
  return note !== null && typeof note === 'object' && Object.hasOwn(NOTE_KINDS, note?.kind) && typeof note.text === 'string'
    && (note.id === undefined || typeof note.id === 'string') && (note.at === undefined || typeof note.at === 'string')
    && (note.delivered === undefined || typeof note.delivered === 'boolean')
}

function parseState(raw) {
  let state
  try {
    state = JSON.parse(raw)
  } catch {
    return undefined
  }
  const valid = state !== null && typeof state === 'object' && Number.isInteger(state.next) && Array.isArray(state.entries) && Array.isArray(state.notes)
    && state.entries.every(isEntry) && state.notes.every(isNote)
    && (state.usage === undefined || (state.usage !== null && typeof state.usage === 'object'))
  if (!valid) return undefined
  state.usage = usageOf(state)
  return state
}

function isEntry(entry) {
  const lines = (value) => Array.isArray(value) && value.every((line) => typeof line === 'string')
  return entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && /^i\d+$/.test(entry.id) && typeof entry.text === 'string'
    && STATUSES.includes(entry.status) && lines(entry.why) && lines(entry.decided)
    && (entry.delivered === undefined || typeof entry.delivered === 'boolean')
    && (entry.reverts === undefined || (lines(entry.reverts) && entry.reverts.every((id) => /^i\d+$/.test(id))))
    && (entry.userEdits === undefined || (Array.isArray(entry.userEdits) && entry.userEdits.every((edit) =>
      edit !== null && typeof edit === 'object' && typeof edit.id === 'string' && typeof edit.at === 'string'
      && typeof edit.text === 'string' && STATUSES.includes(edit.status) && typeof edit.clarification === 'string')))
}

/** full — всё; brief — открытые полностью, остальные одной строкой. */
export function render(state, mode) {
  const lines = []
  for (const entry of state.entries) {
    const head = `- [${entry.id}] ${entry.text}${entry.prompt === undefined ? '' : ` → ${entry.prompt}`} — ${entry.status}`
    lines.push(head)
    const correction = entry.userEdits?.at(-1)
    if (correction !== undefined && entry.reverted !== true) lines.push(`  **User correction:** ${JSON.stringify(correction)}`)
    if (mode === 'brief' && entry.status !== 'open') continue
    for (const why of entry.why) lines.push(`  **why:** ${why}`)
    for (const decided of entry.decided) lines.push(`  **I decided:** ${decided}`)
  }
  for (const note of state.notes) lines.push(`*${NOTE_KINDS[note.kind]}: ${note.text}*`)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/** Сумма токенов последнего ответа модели после последнего сжатия; расход всей сессии не используется. */
export function reportedContext(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.type === 'compaction' && message.status === 'completed') return undefined
    if (message.type !== 'assistant' || message.tokens === undefined) continue
    const { input, output, reasoning, cache } = message.tokens
    return { messageID: message.id, tokens: input + output + reasoning + cache.read + cache.write }
  }
  return undefined
}

export function latestCompaction(messages) {
  return messages.findLast((message) => message.type === 'compaction' && message.status === 'completed')
}

/** Удаляет каталоги сессий без изменений не менее срока хранения. Возвращает удалённые ID. */
export async function pruneOld(root, now = Date.now()) {
  const limit = now - POLICY.retentionDays * 24 * 60 * 60 * 1000
  let names
  try {
    names = await readdir(root)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const removed = []
  for (const name of names.filter((candidate) => candidate.startsWith('ses_'))) {
    const folder = join(root, name)
    try {
      const info = await stat(folder)
      if (!info.isDirectory() || info.mtimeMs > limit) continue
      await rm(folder, { recursive: true, force: true })
      removed.push(name)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return removed
}

export async function logEvent(root, line) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  await appendFile(join(root, 'plugin.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
}
