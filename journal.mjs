import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const POLICY = Object.freeze({
  // Мягкий порог: сначала напоминание модели, на следующем шаге — штатное сжатие. Ничего не блокируется.
  compactAt: 300_000,
  retentionDays: 30,
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
    return (raw === undefined ? undefined : parseState(raw)) ?? emptyState(await this.#nextFreeID(sessionID))
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
      const numbers = (await readdir(join(sessionDir(this.root, sessionID), 'prompts'))).map((name) => /^i(\d+)\.md$/.exec(name)?.[1]).filter(Boolean).map(Number)
      return Math.max(0, ...numbers) + 1
    } catch (error) {
      if (error.code === 'ENOENT') return 1
      throw error
    }
  }

  async #loadForWrite(sessionID) {
    const raw = await this.#read(sessionID)
    if (raw === undefined) return emptyState(1)
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
    await writeAtomic(folder, 'intent.md', render(state, 'full')).catch((error) => this.onError(`intent.md: ${error.message}`))
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
  recordPrompt(sessionID, messageID, text) {
    return this.#mutate(sessionID, async (state) => {
      const existing = state.entries.find((entry) => entry.messageID === messageID)
      if (existing !== undefined) return existing.id
      const id = `i${state.next++}`
      await writeAtomic(join(sessionDir(this.root, sessionID), 'prompts'), `${id}.md`, text)
      state.entries.push({ id, text: PENDING, status: 'open', why: [], decided: [], messageID, prompt: `prompts/${id}.md` })
      return id
    })
  }

  addIntent(sessionID, { text, why, decided }) {
    return this.#mutate(sessionID, (state) => {
      const id = `i${state.next++}`
      state.entries.push({ id, text, status: 'open', why: why === undefined ? [] : [why], decided: decided === undefined ? [] : [decided] })
      return id
    })
  }

  addNote(sessionID, kind, text) {
    if (!Object.hasOwn(NOTE_KINDS, kind)) throw new Error(`Неизвестный вид записи: ${kind}; допустимо: intent, ${Object.keys(NOTE_KINDS).join(', ')}`)
    return this.#mutate(sessionID, (state) => {
      state.notes.push({ kind, text })
    })
  }

  /** target: { id } — запись по ID; { messageID } — запись сообщения пользователя. Возвращает ID изменённой записи. */
  update(sessionID, target, { text, status, why, decided }) {
    if (status !== undefined && !STATUSES.includes(status)) throw new Error(`Неизвестный статус: ${status}; допустимо: ${STATUSES.join(', ')}`)
    return this.#mutate(sessionID, (state) => {
      const entry = target.id === undefined
        ? state.entries.find((candidate) => candidate.messageID === target.messageID)
        : state.entries.find((candidate) => candidate.id === target.id)
      if (entry === undefined) throw new Error(target.id === undefined ? 'Для сообщения, на которое ты отвечаешь, нет записи; укажи id' : `Запись ${target.id} не найдена; есть: ${state.entries.map((candidate) => candidate.id).join(', ') || 'нет записей'}`)
      if (text !== undefined) entry.text = text
      if (status !== undefined) entry.status = status
      if (why !== undefined) entry.why.push(why)
      if (decided !== undefined) entry.decided.push(decided)
      return entry.id
    })
  }

  /** Закрывает записи откатанных сообщений. Возвращает их ID. */
  markReverted(sessionID, visibleMessageIDs, compacted) {
    return this.#mutate(sessionID, (state) => {
      const ids = revertedIDs(state, visibleMessageIDs, compacted)
      for (const entry of state.entries.filter((candidate) => ids.includes(candidate.id))) {
        entry.status = 'dropped'
        entry.reverted = true
        entry.why.push(REVERTED_WHY)
      }
      return ids
    })
  }

  async readPrompt(sessionID, id) {
    if (!/^i\d+$/.test(id)) throw new Error(`Некорректный ID записи: ${id}`)
    try {
      return await readFile(join(sessionDir(this.root, sessionID), 'prompts', `${id}.md`), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`У записи ${id} нет сохранённого сообщения`, { cause: error })
      throw error
    }
  }
}

export function pendingIDs(state) {
  return state.entries.filter((entry) => entry.status === 'open' && entry.text === PENDING).map((entry) => entry.id)
}

/**
 * Сообщения пользователя, которые пропали из контекста между видимыми сообщениями, — откатанные.
 * Записи позже последнего видимого — ещё в очереди. Раньше первого видимого — откатаны, если сжатия не было,
 * иначе их не отличить от ушедших в сводку, и они не трогаются.
 */
export function revertedIDs(state, visibleMessageIDs, compacted) {
  const visible = new Set(visibleMessageIDs)
  const positions = state.entries.flatMap((entry, index) => visible.has(entry.messageID) ? [index] : [])
  if (positions.length === 0) return []
  return state.entries.slice(compacted ? positions[0] : 0, positions.at(-1))
    .filter((entry) => entry.messageID !== undefined && !visible.has(entry.messageID) && entry.reverted !== true)
    .map((entry) => entry.id)
}

const REVERTED_WHY = 'Пользователь откатил это сообщение'
const emptyState = (next) => ({ next, entries: [], notes: [] })

function parseState(raw) {
  let state
  try {
    state = JSON.parse(raw)
  } catch {
    return undefined
  }
  const valid = state !== null && typeof state === 'object' && Number.isInteger(state.next) && Array.isArray(state.entries) && Array.isArray(state.notes)
    && state.entries.every(isEntry) && state.notes.every((note) => Object.hasOwn(NOTE_KINDS, note?.kind) && typeof note.text === 'string')
  return valid ? state : undefined
}

function isEntry(entry) {
  const lines = (value) => Array.isArray(value) && value.every((line) => typeof line === 'string')
  return entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.text === 'string'
    && STATUSES.includes(entry.status) && lines(entry.why) && lines(entry.decided)
}

/** full — всё; brief — открытые полностью, остальные одной строкой. */
export function render(state, mode) {
  const lines = []
  for (const entry of state.entries) {
    const head = `- [${entry.id}] ${entry.text}${entry.prompt === undefined ? '' : ` → ${entry.prompt}`} — ${entry.status}`
    lines.push(head)
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

/** Удаляет каталоги сессий без изменений дольше срока хранения. Возвращает удалённые ID. */
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
      if (!info.isDirectory() || info.mtimeMs >= limit) continue
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
