import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { Journal, pruneOld, render, reportedContext } from '../journal.mjs'
import { setup } from '../runtime.mjs'

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'intent-journal-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function host({ parentID } = {}) {
  const hooks = new Map()
  const tools = new Map()
  const storage = new Map()
  const calls = []
  const messages = []
  const ctx = {
    storage: { get: async (key) => storage.get(key), set: async (key, value) => storage.set(key, value), remove: async (key) => storage.delete(key) },
    session: {
      hook: async (name, handler) => { hooks.set(name, handler); return { dispose: async () => hooks.delete(name) } },
      get: async ({ sessionID }) => ({ id: sessionID, parentID }),
      context: async () => messages,
      compact: async (input) => { calls.push(['compact', input]) },
    },
    tool: { transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); return { dispose: async () => tools.clear() } } },
  }
  return { ctx, hooks, tools, messages, calls }
}

const request = () => ({ sessionID: 'ses_test', messages: [], system: [], tools: { intent_note: {}, intent_update: {}, read: {} }, options: {} })
const prompt = (messageID, text) => ({ sessionID: 'ses_test', messageID, prompt: { text }, delivery: 'queue' })
const assistant = (input) => ({ id: `msg_${input}`, type: 'assistant', tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
const systemText = (event) => [...event.system, ...event.messages.filter((message) => message.role === 'system').flatMap((message) => message.content)].map((part) => part.text).join('\n')
const call = (h, name, input) => h.tools.get(name).execute(input, { sessionID: 'ses_test' })
const requestFor = (h) => ({ ...request(), messages: h.messages.filter((message) => message.type === 'user').map((message) => ({ role: 'user', id: message.id, content: [{ type: 'text', text: message.text }] })) })
async function admit(h, id, text) {
  await h.hooks.get('prompt')(prompt(id, text))
  h.messages.push({ id, type: 'user', text })
  await h.hooks.get('context')(requestFor(h))
}

test('длинное сообщение сохраняется целиком, в журнал идёт только заготовка', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  const long = 'очень длинная просьба '.repeat(500)
  await admit(h, 'msg_1', long)
  await h.hooks.get('context')(requestFor(h))
  assert.equal(await readFile(join(root, 'ses_test/prompts/i1.md'), 'utf8'), long)
  const journal = await readFile(join(root, 'ses_test/intent.md'), 'utf8')
  assert.equal(journal, '- [i1] (ждёт сути) → prompts/i1.md — open\n')
})

test('сообщения подагентам не журналируются', async (t) => {
  const root = await sandbox(t)
  const h = host({ parentID: 'ses_parent' })
  await setup(h.ctx, root)
  await h.hooks.get('prompt')(prompt('msg_1', 'задача подагенту'))
  await assert.rejects(readdir(join(root, 'ses_test')), { code: 'ENOENT' })
})

test('модель дописывает суть, why, decided, статус и заметки', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  await admit(h, 'msg_1', 'сделай плагин')
  await call(h, 'intent_update', { id: 'i1', text: 'плагин журнала', why: 'первая версия ломала /compact', decided: 'без логов shell' })
  await call(h, 'intent_update', { id: 'i1', status: 'done' })
  assert.equal((await call(h, 'intent_note', { kind: 'intent', text: 'удалить скилл', decided: 'только локально' })).content, 'Добавлено: i2')
  await call(h, 'intent_note', { kind: 'postponed', text: 'перевыпуск ключа' })
  assert.equal((await call(h, 'intent_update', { id: 'i1', read_prompt: true })).content, 'сделай плагин')
  assert.equal(await readFile(join(root, 'ses_test/intent.md'), 'utf8'), [
    '- [i1] плагин журнала → prompts/i1.md — done',
    '  **why:** первая версия ломала /compact',
    '  **I decided:** без логов shell',
    '- [i2] удалить скилл — open',
    '  **I decided:** только локально',
    '*Postponed: перевыпуск ключа*',
    '',
  ].join('\n'))
  await assert.rejects(call(h, 'intent_update', { id: 'i9', status: 'done' }), /i9 не найдена/)
})

test('параллельные записи одной сессии не теряются', async (t) => {
  const journal = new Journal(await sandbox(t))
  await Promise.all(Array.from({ length: 20 }, (_, index) => journal.addIntent('ses_test', { text: `n${index}` })))
  const state = await journal.load('ses_test')
  assert.equal(state.entries.length, 20)
  assert.equal(new Set(state.entries.map((entry) => entry.id)).size, 20)
})

test('в обычном запросе нет журнала, только короткая инструкция и список заготовок', async (t) => {
  const h = host()
  await setup(h.ctx, await sandbox(t))
  await h.hooks.get('prompt')(prompt('msg_1', 'секретная формулировка пользователя'))
  h.messages.push({ id: 'msg_1', type: 'user', text: 'секретная формулировка пользователя' })
  const event = requestFor(h)
  await h.hooks.get('context')(event)
  const text = systemText(event)
  assert.ok(text.includes('без сути в журнале: i1'))
  assert.ok(!event.system.some((part) => part.text.includes('без сути')), 'изменчивая подсказка не в system')
  assert.ok(!text.includes('секретная формулировка'))
  assert.ok(!text.includes('<intent-journal>'))
})

test('в запрос сводки идёт весь журнал, результат сводки не подменяется', async (t) => {
  const h = host()
  await setup(h.ctx, await sandbox(t))
  await call(h, 'intent_note', { kind: 'intent', text: 'цель A', why: 'причина' })
  await call(h, 'intent_update', { id: 'i1', status: 'done' })
  const event = request()
  await h.hooks.get('compaction')(event)
  assert.equal(event.result, undefined)
  assert.ok(systemText(event).includes('**why:** причина'))
})

test('после сжатия журнал добавляется один раз, завершённые одной строкой', async (t) => {
  const h = host()
  await setup(h.ctx, await sandbox(t))
  await call(h, 'intent_note', { kind: 'intent', text: 'готово', why: 'скрыть' })
  await call(h, 'intent_update', { id: 'i1', status: 'done' })
  await call(h, 'intent_note', { kind: 'intent', text: 'в работе', why: 'показать' })
  h.messages.push({ type: 'compaction', status: 'completed', id: 'msg_c1', reason: 'manual', summary: '...' })
  const first = request()
  await h.hooks.get('context')(first)
  const text = systemText(first)
  assert.ok(text.includes('Контекст был сжат'))
  assert.ok(text.includes('- [i1] готово — done') && !text.includes('скрыть'))
  assert.ok(text.includes('**why:** показать'))
  const second = request()
  await h.hooks.get('context')(second)
  assert.ok(!systemText(second).includes('Контекст был сжат'))
})

test('300k: напоминание и одно сжатие в очереди, без блокировки', async (t) => {
  const h = host()
  await setup(h.ctx, await sandbox(t))
  h.messages.push(assistant(500_000))
  const first = request()
  await h.hooks.get('context')(first)
  assert.ok(systemText(first).includes('Контекст скоро будет сжат'))
  await h.hooks.get('context')(request())
  assert.equal(h.calls.filter(([name]) => name === 'compact').length, 1)
})

test('сбой storage при admission не отключает компакцию и не выдаёт журнал модели', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  h.ctx.storage.get = async () => { throw new Error('storage unavailable') }
  h.messages.push({ id: 'msg_1', type: 'user', text: 'тест' }, assistant(300_000))
  const event = requestFor(h)
  await h.hooks.get('context')(event)
  assert.equal(h.calls.length, 1)
  assert.match(systemText(event), /Контекст скоро будет сжат/)
  assert.doesNotMatch(systemText(event), /Журнал намерений|без сути в журнале/)
  await assert.rejects(call(h, 'intent_update', { text: 'не должно сохраниться' }), /Не удалось определить/)
  assert.match(await readFile(join(root, 'plugin.log'), 'utf8'), /ERROR admission.*storage unavailable/s)
})

test('сбой записи admission не отключает компакцию и не выдаёт журнал модели', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  await writeFile(join(root, 'ses_test'), 'не каталог')
  h.messages.push({ id: 'msg_1', type: 'user', text: 'тест' }, assistant(300_000))
  const event = requestFor(h)
  await h.hooks.get('context')(event)
  assert.equal(h.calls.length, 1)
  assert.doesNotMatch(systemText(event), /Журнал намерений|без сути в журнале/)
  assert.match(await readFile(join(root, 'plugin.log'), 'utf8'), /ERROR admission/)
})

test('повтор записи доставленного сообщения не перезаписывает журнал даже при гонке', async (t) => {
  const root = await sandbox(t)
  const journal = new Journal(root)
  await journal.recordPrompt('ses_test', 'msg_1', 'первое')
  const path = join(root, 'ses_test/intent.json')
  const before = await stat(path)
  const state = await readFile(path, 'utf8')
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => journal.recordPrompt('ses_test', 'msg_1', 'другое'))), ['i1', 'i1', 'i1', 'i1', 'i1'])
  assert.equal((await stat(path)).ino, before.ino)
  assert.equal(await readFile(path, 'utf8'), state)
  assert.equal(await journal.readPrompt('ses_test', 'i1'), 'первое')
})

test('ошибка удаления metadata после записи сохраняет границу для повтора', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  await admit(h, 'msg_1', 'первое')
  h.ctx.session.get = async ({ sessionID }) => ({ id: sessionID, revert: { messageID: 'msg_1' } })
  await h.hooks.get('prompt')(prompt('msg_2', 'новое'))
  h.messages.splice(0, h.messages.length, { id: 'msg_2', type: 'user', text: 'новое' })
  const remove = h.ctx.storage.remove
  h.ctx.storage.remove = async () => { throw new Error('remove failed') }
  await h.hooks.get('context')(requestFor(h))
  assert.equal(await h.ctx.storage.get('rewind/ses_test/msg_2'), 'msg_1')
  const journal = new Journal(root)
  assert.deepEqual((await journal.load('ses_test')).entries[1].reverts, ['i1'])
  h.ctx.storage.remove = remove
  await h.hooks.get('context')(requestFor(h))
  assert.equal(await h.ctx.storage.get('rewind/ses_test/msg_2'), undefined)
  assert.deepEqual((await journal.load('ses_test')).entries.map((entry) => entry.status), ['dropped', 'open'])
})

test('сводка применяет rewind после сбоя очистки metadata и исключает отменённое уточнение', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  await admit(h, 'msg_1', 'первое')
  const journal = new Journal(root)
  const first = (await journal.inspect('ses_test')).entries[0]
  const { entryRevision } = await import('../journal.mjs')
  await journal.edit('ses_test', 'i1', entryRevision(first), { text: 'прежняя задача', status: 'open', clarification: 'RETRACTED_CLARIFICATION' })
  h.ctx.session.get = async ({ sessionID }) => ({ id: sessionID, revert: { messageID: 'msg_1' } })
  await h.hooks.get('prompt')(prompt('msg_2', 'новое'))
  h.messages.splice(0, h.messages.length, { id: 'msg_2', type: 'user', text: 'новое' }, assistant(300_000))
  h.ctx.storage.remove = async () => { throw new Error('remove failed') }
  await h.hooks.get('context')(requestFor(h))
  assert.equal(h.calls.filter(([name]) => name === 'compact').length, 1)
  const summary = request()
  await h.hooks.get('compaction')(summary)
  assert.deepEqual((await journal.inspect('ses_test')).entries.map((entry) => entry.status), ['dropped', 'open'])
  assert.doesNotMatch(systemText(summary), /RETRACTED_CLARIFICATION/)
  assert.match(systemText(summary), /dropped/)
})

test('ошибка плагина не прерывает рабочий запрос и попадает в лог', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  h.ctx.session.context = async () => { throw new Error('boom') }
  await h.hooks.get('context')(request())
  assert.ok((await readFile(join(root, 'plugin.log'), 'utf8')).includes('boom'))
})

test('журналы удаляются через 15 дней неактивности, свежие остаются', async (t) => {
  const root = await sandbox(t)
  await mkdir(join(root, 'ses_old'))
  await mkdir(join(root, 'ses_boundary'))
  await mkdir(join(root, 'ses_new'))
  const now = Date.UTC(2026, 0, 20)
  const boundary = now - 15 * 24 * 60 * 60 * 1000
  for (const [name, time] of [['ses_old', boundary - 1000], ['ses_boundary', boundary], ['ses_new', boundary + 1000]]) {
    await utimes(join(root, name), new Date(time), new Date(time))
  }
  assert.deepEqual((await pruneOld(root, now)).sort(), ['ses_boundary', 'ses_old'])
  assert.deepEqual(await readdir(root), ['ses_new'])
})

test('учёт токенов: cache включён, usage до сжатия игнорируется', () => {
  const message = { id: 'msg_a', type: 'assistant', tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } } }
  assert.equal(reportedContext([message]).tokens, 150)
  assert.equal(reportedContext([message, { type: 'compaction', status: 'completed' }]), undefined)
})

test('пустой журнал не рендерится', () => {
  assert.equal(render({ next: 1, entries: [], notes: [] }, 'full'), '')
})

test('битый или чужой intent.json откладывается, журнал и порог продолжают работать', async (t) => {
  for (const broken of ['{не json', '{}', 'null']) {
    const root = await sandbox(t)
    const h = host()
    await setup(h.ctx, root)
    await mkdir(join(root, 'ses_test'))
    await writeFile(join(root, 'ses_test/intent.json'), broken)
    h.messages.push(assistant(500_000))
    await h.hooks.get('context')(request())
    assert.equal(h.calls.length, 1, broken)
    await admit(h, 'msg_1', 'после поломки')
    assert.equal(await readFile(join(root, 'ses_test/intent.md'), 'utf8'), '- [i1] (ждёт сути) → prompts/i1.md — open\n')
    assert.ok((await readdir(join(root, 'ses_test'))).some((name) => name.startsWith('intent.json.corrupt-')))
  }
})

test('подагент: без инструкции, без инструментов журнала, без журнала в сводке', async (t) => {
  const h = host({ parentID: 'ses_parent' })
  await setup(h.ctx, await sandbox(t))
  const event = request()
  await h.hooks.get('context')(event)
  assert.deepEqual(Object.keys(event.tools), ['read'])
  assert.equal(systemText(event), '')
  const summary = request()
  await h.hooks.get('compaction')(summary)
  assert.equal(summary.system.length, 0)
  assert.deepEqual(Object.keys(summary.tools), ['read'])
})

test('подагент: прямой вызов инструментов и сводка не раскрывают существующий журнал', async (t) => {
  const root = await sandbox(t)
  const h = host({ parentID: 'ses_parent' })
  await setup(h.ctx, root)
  await new Journal(root).recordPrompt('ses_test', 'msg_old', 'старый журнал')
  const summary = request()
  await h.hooks.get('compaction')(summary)
  assert.equal(systemText(summary), '')
  await assert.rejects(call(h, 'intent_note', { kind: 'intent', text: 'задача' }), /журнал.*подагент/i)
  await assert.rejects(call(h, 'intent_update', { id: 'i1', read_prompt: true }), /журнал.*подагент/i)
})

test('подагент: компакция запрашивается один раз на достигший порога ответ', async (t) => {
  const root = await sandbox(t)
  const h = host({ parentID: 'ses_parent' })
  await setup(h.ctx, root)
  h.messages.push(assistant(300_000))
  await h.hooks.get('context')(request())
  await h.hooks.get('context')(request())
  assert.deepEqual(h.calls, [['compact', { sessionID: 'ses_test' }]])
  await assert.rejects(readdir(join(root, 'ses_test')), { code: 'ENOENT' })
})

test('список заготовок ограничен, intent_update без id правит последнее сообщение', async (t) => {
  const h = host()
  await setup(h.ctx, await sandbox(t))
  for (let index = 1; index <= 8; index++) {
    await h.hooks.get('prompt')(prompt(`msg_${index}`, `сообщение ${index}`))
    h.messages.push({ id: `msg_${index}`, type: 'user', text: `сообщение ${index}` })
  }
  const event = requestFor(h)
  await h.hooks.get('context')(event)
  assert.ok(systemText(event).includes('i4, i5, i6, i7, i8 и ещё 3 более ранних'))
  assert.equal((await call(h, 'intent_update', { text: 'суть восьмого' })).content, 'Обновлено: i8')
  assert.match((await call(h, 'intent_update', { id: 'i8', status: 'done', read_prompt: true })).content, /Обновлено: i8\n\nсообщение 8/)
})

test('восстановление после сжатия не повторяется после перезапуска плагина', async (t) => {
  const root = await sandbox(t)
  const first = host()
  await setup(first.ctx, root)
  await call(first, 'intent_note', { kind: 'intent', text: 'цель' })
  const compaction = { type: 'compaction', status: 'completed', id: 'msg_c1', reason: 'auto', summary: '...' }
  first.messages.push(compaction)
  await first.hooks.get('context')(request())
  const second = host()
  second.ctx.storage = first.ctx.storage
  await setup(second.ctx, root)
  second.messages.push(compaction)
  const event = request()
  await second.hooks.get('context')(event)
  assert.ok(!systemText(event).includes('Контекст был сжат'))
})

test('запись в journal обновляет mtime каталога сессии (иначе очистка удалит активную)', async (t) => {
  const root = await sandbox(t)
  const journal = new Journal(root)
  await journal.addIntent('ses_test', { text: 'a' })
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  await utimes(join(root, 'ses_test'), old, old)
  await journal.addIntent('ses_test', { text: 'b' })
  assert.deepEqual(await pruneOld(root), [])
})

test('закрытая заготовка без сути не висит в списке ожидающих', async (t) => {
  const h = host()
  await setup(h.ctx, await sandbox(t))
  await admit(h, 'msg_1', 'ок')
  await call(h, 'intent_update', { id: 'i1', status: 'dropped' })
  const event = request()
  await h.hooks.get('context')(event)
  assert.ok(!systemText(event).includes('без сути'))
})

test('после потери intent.json сохранённые тексты сообщений не перезаписываются', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  await admit(h, 'msg_1', 'первое')
  await admit(h, 'msg_2', 'второе')
  await writeFile(join(root, 'ses_test/intent.json'), '{битый')
  await h.hooks.get('prompt')(prompt('msg_3', 'третье'))
  h.messages.push({ id: 'msg_3', type: 'user', text: 'третье' })
  const event = requestFor(h)
  event.messages = event.messages.filter((message) => message.id === 'msg_3')
  await h.hooks.get('context')(event)
  assert.equal(await readFile(join(root, 'ses_test/prompts/i1.md'), 'utf8'), 'первое')
  assert.equal(await readFile(join(root, 'ses_test/prompts/i3.md'), 'utf8'), 'третье')
})

test('неожиданная форма данных OpenCode не ломает рабочий запрос', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  h.messages.push({ id: 'msg_x', type: 'assistant', tokens: { input: 1, output: 1, reasoning: 0 } })
  const event = request()
  await h.hooks.get('context')(event)
  assert.ok(systemText(event).includes('Журнал намерений'))
  assert.ok((await readFile(join(root, 'plugin.log'), 'utf8')).includes('ERROR'))
})

test('если тип сессии неизвестен: журнал не записывается, инструменты скрываются', async (t) => {
  const root = await sandbox(t)
  const h = host()
  h.ctx.session.get = async () => { throw new Error('get failed') }
  await setup(h.ctx, root)
  await h.hooks.get('prompt')(prompt('msg_1', 'важное'))
  await assert.rejects(readdir(join(root, 'ses_test')), { code: 'ENOENT' })
  const event = request()
  await h.hooks.get('context')(event)
  assert.deepEqual(Object.keys(event.tools), ['read'])
  const summary = request()
  await h.hooks.get('compaction')(summary)
  assert.deepEqual(Object.keys(summary.tools), ['read'])
  await assert.rejects(call(h, 'intent_update', { id: 'i1', read_prompt: true }), /get failed/)
})

test('правка без id идёт в сообщение, которое видела модель, а не в пришедшее во время ответа', async (t) => {
  const h = host()
  await setup(h.ctx, await sandbox(t))
  await admit(h, 'msg_1', 'первое')
  await h.hooks.get('prompt')(prompt('msg_2', 'второе, пока модель отвечает'))
  h.messages.push({ id: 'msg_2', type: 'user', text: 'второе' })
  assert.equal((await call(h, 'intent_update', { text: 'суть первого' })).content, 'Обновлено: i1')
})

test('без совпадающего ID в запросе запись не создаётся, совпадение по тексту не используется', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  await h.hooks.get('prompt')(prompt('msg_1', 'тот же текст'))
  h.messages.push({ id: 'msg_1', type: 'user', text: 'тот же текст' })
  const event = request()
  event.messages.push({ role: 'user', content: [{ type: 'text', text: 'тот же текст' }] })
  await h.hooks.get('context')(event)
  assert.deepEqual((await new Journal(root).load('ses_test')).entries, [])
  assert.ok(!systemText(event).includes('без сути в журнале'))
  await assert.rejects(call(h, 'intent_update', { text: 'ошибка' }), /Не удалось определить/)
  assert.match(await readFile(join(root, 'plugin.log'), 'utf8'), /user message without ID/)
})

test('последнее сообщение без ID не направляет правку без id в предыдущую запись', async (t) => {
  const h = host()
  await setup(h.ctx, await sandbox(t))
  await admit(h, 'msg_1', 'первое')
  h.messages.push({ id: 'msg_2', type: 'user', text: 'второе' })
  const event = requestFor(h)
  delete event.messages.at(-1).id
  await h.hooks.get('context')(event)
  await assert.rejects(call(h, 'intent_update', { text: 'суть второго' }), /Не удалось определить/)
})

test('сохраняется канонический текст, а не черновик из prompt hook', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  await h.hooks.get('prompt')(prompt('msg_1', 'черновик'))
  h.messages.push({ id: 'msg_1', type: 'user', text: 'канонический текст' })
  await h.hooks.get('context')(requestFor(h))
  assert.equal(await readFile(join(root, 'ses_test/prompts/i1.md'), 'utf8'), 'канонический текст')
})

test('неподтверждённая запись не становится доставленной при совпадении ID', async (t) => {
  const root = await sandbox(t)
  const folder = join(root, 'ses_test')
  await mkdir(join(folder, 'prompts'), { recursive: true })
  const unconfirmed = { id: 'i1', messageID: 'msg_1', text: 'неподтверждено', status: 'open', why: [], decided: [], prompt: 'prompts/i1.md' }
  await writeFile(join(folder, 'intent.json'), JSON.stringify({ next: 2, entries: [unconfirmed], notes: [] }))
  await writeFile(join(folder, 'prompts/i1.md'), 'неподтверждённый текст')
  const journal = new Journal(root)
  assert.equal(await journal.recordPrompt('ses_test', 'msg_1', 'доставленный текст'), 'i2')
  assert.equal(await journal.recordPrompt('ses_test', 'msg_1', 'повтор'), 'i2')
  const saved = JSON.parse(await readFile(join(folder, 'intent.json'), 'utf8'))
  assert.deepEqual(saved.entries[0], unconfirmed)
  assert.deepEqual((await journal.load('ses_test')).entries.map((entry) => entry.id), ['i2'])
  await assert.rejects(journal.readPrompt('ses_test', 'i1'), /нет доступного сообщения/)
  assert.equal(await journal.readPrompt('ses_test', 'i2'), 'доставленный текст')
  assert.deepEqual((await readdir(join(folder, 'prompts'))).sort(), ['i1.md', 'i2.md'])
})

test('метаданные staged rewind переживают перезагрузку и не содержат текст очереди', async (t) => {
  const root = await sandbox(t)
  const first = host()
  await setup(first.ctx, root)
  await admit(first, 'msg_1', 'первое')
  await admit(first, 'msg_2', 'второе')
  first.ctx.session.get = async ({ sessionID }) => ({ id: sessionID, revert: { messageID: 'msg_2' } })
  await first.hooks.get('prompt')(prompt('msg_3', 'секрет очереди'))
  assert.equal(await first.ctx.storage.get('rewind/ses_test/msg_3'), 'msg_2')
  assert.equal((await new Journal(root).load('ses_test')).entries.length, 2)
  const second = host()
  second.ctx.storage = first.ctx.storage
  await setup(second.ctx, root)
  second.messages.push({ id: 'cmp_1', type: 'compaction', status: 'completed' }, { id: 'msg_3', type: 'user', text: 'секрет очереди' })
  await second.hooks.get('context')(requestFor(second))
  assert.deepEqual((await new Journal(root).load('ses_test')).entries.map((entry) => entry.status), ['open', 'dropped', 'open'])
  assert.equal(await second.ctx.storage.get('rewind/ses_test/msg_3'), undefined)
})

test('откатанные сообщения закрываются, ушедшие при сжатии и ещё не показанные модели — нет', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  for (const index of [1, 2, 3, 4]) await admit(h, `msg_${index}`, `сообщение ${index}`)
  await h.hooks.get('prompt')(prompt('msg_5', 'сообщение 5'))
  // msg_1 ушло при сжатии, msg_3 откатано, msg_5 ещё в очереди.
  h.messages.splice(0, h.messages.length, { id: 'cmp_1', type: 'compaction', status: 'completed' }, { id: 'msg_2', type: 'user', text: 'сообщение 2' }, { id: 'msg_4', type: 'user', text: 'сообщение 4' })
  const event = requestFor(h)
  await h.hooks.get('context')(event)
  const state = JSON.parse(await readFile(join(root, 'ses_test/intent.json'), 'utf8'))
  assert.deepEqual(state.entries.map((entry) => [entry.id, entry.status]), [['i1', 'open'], ['i2', 'open'], ['i3', 'dropped'], ['i4', 'open']])
  assert.deepEqual(state.entries[2].why, ['Пользователь откатил это сообщение'])
  assert.match(systemText(event), /без сути в журнале: i1, i2, i4\./)
  await h.hooks.get('context')(request())
  assert.deepEqual(JSON.parse(await readFile(join(root, 'ses_test/intent.json'), 'utf8')).entries[2].why, ['Пользователь откатил это сообщение'], 'повторно не помечается')
})

test('без сжатия откат с первого сообщения закрывает все ранние записи', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  for (const index of [1, 2, 3]) await admit(h, `msg_${index}`, `сообщение ${index}`)
  h.messages.splice(0, h.messages.length, { id: 'msg_3', type: 'user', text: 'сообщение 3' })
  await h.hooks.get('context')(requestFor(h))
  const state = JSON.parse(await readFile(join(root, 'ses_test/intent.json'), 'utf8'))
  assert.deepEqual(state.entries.map((entry) => entry.status), ['dropped', 'dropped', 'open'])
})

test('точная граница rewind закрывает отменённые записи после сжатия', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  for (const index of [1, 2, 3]) await admit(h, `msg_${index}`, `сообщение ${index}`)
  h.ctx.session.get = async ({ sessionID }) => ({ id: sessionID, revert: { messageID: 'msg_2' } })
  await h.hooks.get('prompt')(prompt('msg_4', 'новая ветка'))
  const before = await new Journal(root).load('ses_test')
  assert.equal(before.entries.length, 3)
  assert.ok(before.entries.every((entry) => entry.status === 'open'), 'до подтверждения admission статусы не меняются')
  h.messages.splice(0, h.messages.length, { id: 'cmp_1', type: 'compaction', status: 'completed' }, { id: 'msg_4', type: 'user', text: 'новая ветка' })
  await h.hooks.get('context')(requestFor(h))
  assert.deepEqual((await new Journal(root).load('ses_test')).entries.map((entry) => entry.status), ['open', 'dropped', 'dropped', 'open'])
  await h.hooks.get('context')(request())
  assert.equal((await new Journal(root).load('ses_test')).entries[1].why.length, 1, 'повторный context не дублирует причину')
})

test('неудавшийся admission с staged rewind не закрывает прежние записи', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  for (const index of [1, 2, 3]) {
    await admit(h, `msg_${index}`, `сообщение ${index}`)
  }
  h.ctx.session.get = async ({ sessionID }) => ({ id: sessionID, revert: { messageID: 'msg_2' } })
  await h.hooks.get('prompt')(prompt('msg_failed', 'не прошло подготовку'))
  // msg_failed не попал в видимую историю: завершившаяся подготовка — не то же, что admission.
  await h.hooks.get('context')(request())
  assert.ok((await new Journal(root).load('ses_test')).entries.every((entry) => entry.reverted !== true))
})

test('граница rewind переживает перезагрузку плагина до следующего запроса', async (t) => {
  const root = await sandbox(t)
  const journal = new Journal(root)
  await journal.recordPrompt('ses_test', 'msg_1', 'первое')
  await journal.recordPrompt('ses_test', 'msg_2', 'второе')
  await journal.recordPrompt('ses_test', 'msg_3', 'новая ветка', 'msg_2')
  const h = host()
  await setup(h.ctx, root)
  h.messages.push({ id: 'cmp_1', type: 'compaction', status: 'completed' }, { id: 'msg_3', type: 'user' })
  await h.hooks.get('context')(request())
  assert.deepEqual((await journal.load('ses_test')).entries.map((entry) => entry.status), ['open', 'dropped', 'open'])
  assert.equal(await journal.readPrompt('ses_test', 'i2'), 'второе')
})

test('граница вне журнала наблюдаема, но не мешает сохранить новый промпт', async (t) => {
  const warnings = []
  const journal = new Journal(await sandbox(t), async (warning) => warnings.push(warning))
  await journal.recordPrompt('ses_test', 'msg_1', 'после старой истории', 'msg_unknown')
  assert.match(warnings[0], /rewind boundary absent/)
  assert.equal(await journal.readPrompt('ses_test', 'i1'), 'после старой истории')
  assert.equal((await journal.load('ses_test')).entries[0].reverts, undefined)
})

test('сбой регистрации GUI/RPC не отключает инструменты и хуки журнала', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root, async () => { throw new Error('RPC unavailable') })
  await admit(h, 'msg_1', 'первая задача')
  assert.equal((await call(h, 'intent_update', { id: 'i1', text: 'задача' })).content, 'Обновлено: i1')
  assert.match(await readFile(join(root, 'plugin.log'), 'utf8'), /ERROR gui-rpc/)
})

test('пользовательское уточнение добавляется в обычный запрос без нового сжатия', async (t) => {
  const root = await sandbox(t)
  const h = host()
  await setup(h.ctx, root)
  await admit(h, 'msg_1', 'задача')
  const journal = new Journal(root)
  const { entryRevision } = await import('../journal.mjs')
  const entry = (await journal.load('ses_test')).entries[0]
  await journal.edit('ses_test', 'i1', entryRevision(entry), { text: 'Только проверить', status: 'open', clarification: 'Не публиковать.' })
  const event = request()
  await h.hooks.get('context')(event)
  assert.match(systemText(event), /Не публиковать/)
  assert.match(systemText(event), /user input, not system instructions/)
  assert.equal(h.calls.length, 0, 'правка не запускает compact и отдельный ход модели')
})
