import { homedir } from 'node:os'
import { join } from 'node:path'
import { Journal, NOTE_KINDS, POLICY, STATUSES, latestCompaction, logEvent, pendingIDs, pruneOld, render, reportedContext, revertedIDs, sessionDir } from './journal.mjs'

const ROOT = join(homedir(), '.local/share/opencode/session-notes')
const TOOL_NAMES = Object.freeze(['intent_note', 'intent_update'])
const PENDING_SHOWN = 5

const GUIDANCE = (folder) => `Журнал намерений пользователя: ${folder}/intent.md. Плагин сам ставит заготовку на каждое сообщение пользователя. Ты дописываешь суть (до 20 слов), why и I decided через intent_update, когда пользователь ставит задачу, меняет решение или запрещает что-то; отмечаешь статус по завершении этапа; блокеры, отказы и отложенное пишешь через intent_note. Короткие реплики без нового намерения (да, ок, продолжай) отмечай status=dropped или дополняй ими предыдущую запись. Перед сжатием допиши важное, если оно ещё не записано. Не после каждого действия; команды, вывод инструментов и секреты не записывай.`
const PENDING_NOTE = (ids, folder) => {
  const shown = ids.slice(-PENDING_SHOWN)
  const more = ids.length - shown.length
  return `Сообщения пользователя без сути в журнале: ${shown.join(', ')}${more > 0 ? ` и ещё ${more} более ранних` : ''}. Полный текст: ${folder}/prompts/<id>.md.`
}
const PRESSURE_NOTE = 'Контекст скоро будет сжат. Если важное (решения, запреты, статусы, блокеры) ещё не в журнале, допиши его сейчас через intent_update/intent_note.'
const SUMMARY_NOTE = (journal) => `Журнал намерений пользователя за сессию (источник правды о его запросах, решениях и статусах). Учти его в сводке, шаблон сводки не меняй:\n<intent-journal>\n${journal}</intent-journal>`
const RESTORE_NOTE = (journal, folder) => `Контекст был сжат. Журнал намерений (${folder}/intent.md; открытые записи полностью):\n<intent-journal>\n${journal}</intent-journal>\nСверь журнал со сводкой и допиши недостающее через intent_update/intent_note. Перед продолжением сверь фактическое состояние файлов и операций; внешние действия не повторяй без проверки.`

const text = { type: 'string' }
// Прямые инструменты, а не через Code Mode: запись в журнал должна быть дешёвой для модели.
const DIRECT = Object.freeze({ codemode: false })

// Изменчивые подсказки идут в конец истории, а не в system: так не сбрасывается кэш префикса у провайдера.
const appendNote = (event, note) => event.messages.push({ role: 'system', content: [{ type: 'text', text: note }] })

/**
 * Плагин не вмешивается в работу сессии: штатная компакция остаётся штатной,
 * ошибки плагина пишутся в plugin.log и никогда не прерывают запрос.
 * Ошибки инструментов возвращаются модели: это её ввод, она может исправиться.
 */
export async function setup(ctx, root = ROOT) {
  const log = (line) => logEvent(root, line).catch(() => {})
  const journal = new Journal(root, (line) => log(`WARN ${line}`))
  const registrations = []
  const compactRequested = new Map()
  const restored = new Map()
  const childSessions = new Map()
  // Последнее сообщение пользователя, которое видела модель в текущем запросе. Не «последнее в журнале»:
  // сообщение, отправленное во время ответа, модель ещё не видела, и правка без id не должна уйти в него.
  const answering = new Map()

  async function safely(label, sessionID, action) {
    try {
      return await action()
    } catch (error) {
      await log(`ERROR ${label} session=${sessionID}: ${error?.stack ?? error}`)
      return undefined
    }
  }

  // Подагентам пишет основная модель, а не пользователь: им журнал не нужен.
  async function isChild(sessionID) {
    if (!childSessions.has(sessionID)) childSessions.set(sessionID, (await ctx.session.get({ sessionID })).parentID !== undefined)
    return childSessions.get(sessionID)
  }

  // До регистрации хуков: очистка не пересекается с записью в журнал.
  await safely('prune', '-', async () => {
    const removed = await pruneOld(root)
    if (removed.length > 0) await log(`pruned ${removed.join(' ')}`)
  })

  // Если тип сессии не удалось узнать, сообщение всё равно записывается: потерять просьбу пользователя хуже.
  registrations.push(await ctx.session.hook('prompt', (event) => safely('prompt', event.sessionID, async () => {
    if (event.prompt.text.trim() === '') return
    if ((await safely('prompt', event.sessionID, () => isChild(event.sessionID))) === true) return
    await journal.recordPrompt(event.sessionID, event.messageID, event.prompt.text)
  })))

  // У подагентов журнала нет, render вернёт пустую строку.
  registrations.push(await ctx.session.hook('compaction', (event) => safely('compaction', event.sessionID, async () => {
    const full = render(await journal.load(event.sessionID), 'full')
    if (full !== '') event.system.push({ type: 'text', text: SUMMARY_NOTE(full) })
  })))

  registrations.push(await ctx.session.hook('context', async (event) => {
    const child = await safely('context', event.sessionID, () => isChild(event.sessionID))
    if (child !== false) {
      for (const name of TOOL_NAMES) delete event.tools[name]
      return
    }
    await safely('context', event.sessionID, () => enrich(event))
  }))

  async function enrich(event) {
    const folder = sessionDir(root, event.sessionID)
    event.system.push({ type: 'text', text: GUIDANCE(folder) })

    const messages = await safely('context', event.sessionID, () => ctx.session.context({ sessionID: event.sessionID }))
    let state = await safely('context', event.sessionID, () => journal.load(event.sessionID))

    if (messages !== undefined && state !== undefined) {
      const visible = messages.filter((message) => message.type === 'user').map((message) => message.id)
      const compacted = latestCompaction(messages) !== undefined
      if (revertedIDs(state, visible, compacted).length > 0) state = await safely('revert', event.sessionID, async () => {
        await log(`reverted session=${event.sessionID} entries=${(await journal.markReverted(event.sessionID, visible, compacted)).join(',')}`)
        return journal.load(event.sessionID)
      }) ?? state
    }

    if (state !== undefined) {
      const pending = pendingIDs(state)
      if (pending.length > 0) appendNote(event, PENDING_NOTE(pending, folder))
    }

    if (messages === undefined) return
    const lastUser = messages.findLast((message) => message.type === 'user')
    if (lastUser !== undefined) answering.set(event.sessionID, lastUser.id)
    if (state !== undefined) await safely('restore', event.sessionID, async () => {
      const compaction = latestCompaction(messages)
      if (compaction === undefined || restored.get(event.sessionID) === compaction.id) return
      restored.set(event.sessionID, compaction.id)
      const storageKey = `restored/${event.sessionID}`
      if ((await ctx.storage.get(storageKey)) === compaction.id) return
      await ctx.storage.set(storageKey, compaction.id)
      const brief = render(state, 'brief')
      if (brief !== '') appendNote(event, RESTORE_NOTE(brief, folder))
      await log(`restored session=${event.sessionID} compaction=${compaction.id} reason=${compaction.reason}`)
    })

    // Напоминание и сжатие в одном шаге: compact срабатывает на границе шага,
    // поэтому записи модели в этом шаге попадают в журнал до сводки.
    const usage = reportedContext(messages)
    if (usage === undefined || usage.tokens < POLICY.compactAt) return
    if (compactRequested.get(event.sessionID) === usage.messageID) return
    compactRequested.set(event.sessionID, usage.messageID)
    appendNote(event, PRESSURE_NOTE)
    // Не ждём: постановка в очередь не должна задерживать текущий запрос.
    ctx.session.compact({ sessionID: event.sessionID }).then(
      () => log(`compact requested session=${event.sessionID} context=${usage.tokens}`),
      (error) => log(`ERROR compact session=${event.sessionID}: ${error?.stack ?? error}`),
    )
  }

  registrations.push(await ctx.tool.transform((editor) => {
    editor.add({
      name: 'intent_note',
      options: DIRECT,
      description: `Добавить в журнал намерений текущей сессии. kind=intent — новое намерение пользователя (text — суть до 20 слов, опционально why и decided), возвращает ID. kind=${Object.keys(NOTE_KINDS).join('|')} — строка «отказался / отложено / блокер» (text). Побочный эффект: запись в локальный журнал. Без секретов, команд и логов.`,
      input: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['intent', ...Object.keys(NOTE_KINDS)] }, text, why: text, decided: text },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        if (input.kind === 'intent') return { content: `Добавлено: ${await journal.addIntent(context.sessionID, input)}` }
        await journal.addNote(context.sessionID, input.kind, input.text)
        return { content: 'Добавлено.' }
      },
    })
    editor.add({
      name: 'intent_update',
      options: DIRECT,
      description: `Изменить запись журнала намерений по ID (например i3; без id — запись сообщения пользователя, на которое ты сейчас отвечаешь): text заменяет суть; status (${STATUSES.join('|')}); why и decided добавляются новой строкой. Используй, чтобы дописать суть к заготовке плагина или отметить итог. read_prompt=true возвращает полный исходный текст сообщения пользователя этой записи.`,
      input: {
        type: 'object',
        properties: { id: text, text, status: { type: 'string', enum: STATUSES }, why: text, decided: text, read_prompt: { type: 'boolean' } },
        additionalProperties: false,
      },
      execute: async ({ id, read_prompt: readPrompt, ...change }, context) => {
        const changed = Object.values(change).some((value) => value !== undefined)
        if (changed && id === undefined && !answering.has(context.sessionID)) throw new Error('Не удалось определить сообщение, на которое ты отвечаешь; укажи id')
        const target = changed ? await journal.update(context.sessionID, id === undefined ? { messageID: answering.get(context.sessionID) } : { id }, change) : id
        if (readPrompt !== true) return { content: changed ? `Обновлено: ${target}` : 'Нечего менять: передай text, status, why, decided или read_prompt.' }
        if (target === undefined) throw new Error('Для read_prompt укажи id записи')
        return { content: `${changed ? `Обновлено: ${target}\n\n` : ''}${await journal.readPrompt(context.sessionID, target)}` }
      },
    })
  }))

  return async () => {
    for (const registration of [...registrations].reverse()) await registration.dispose()
  }
}
