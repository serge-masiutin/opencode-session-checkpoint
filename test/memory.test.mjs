import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal, JournalEditError, entryRevision, render, userCorrections } from '../journal.mjs'
import { memoryApi } from '../memory-api.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'memory-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new Journal(root)
  await journal.recordPrompt('ses_test', 'msg_1', 'Исходный промпт: only staging. Не публиковать.')
  await journal.update('ses_test', { id: 'i1' }, { text: 'Подготовить выпуск', decided: 'Сначала проверить' })
  const api = memoryApi(journal)
  const [entry] = (await api.list({ sessionID: 'ses_test', query: '', filter: 'all' })).entries
  return { root, journal, api, entry }
}

test('GUI читает записи, отдельно промпт и ищет внутри него без передачи всех промптов', async (t) => {
  const { api } = await fixture(t)
  const snapshot = await api.list({ sessionID: 'ses_test', query: 'STAGING', filter: 'all' })
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0].hasPrompt, true)
  assert.equal(snapshot.entries[0].prompt, undefined)
  assert.deepEqual(snapshot.counts, { open: 1, all: 1, decisions: 1 })
  assert.match((await api.prompt({ sessionID: 'ses_test', id: 'i1' })).text, /Исходный промпт/)
})

test('GUI не представляет повреждённый журнал пустым и не меняет его при чтении', async (t) => {
  const { root, api } = await fixture(t)
  const path = join(root, 'ses_test/intent.json')
  await writeFile(path, '{broken')
  await assert.rejects(api.list({ sessionID: 'ses_test', query: '', filter: 'all' }), /journal is invalid/)
  assert.equal(await readFile(path, 'utf8'), '{broken')
})

test('пользователь меняет запись, исходный промпт и выводы агента сохраняются', async (t) => {
  const { api, entry, journal } = await fixture(t)
  const edited = await api.edit({ sessionID: 'ses_test', id: 'i1', revision: entry.revision, text: 'Только подготовить', status: 'postponed', clarification: 'Публикацию не выполнять.' })
  assert.equal(edited.edits.length, 1)
  assert.equal(edited.edits[0].clarification, 'Публикацию не выполнять.')
  assert.equal(edited.status, 'postponed')
  assert.deepEqual(edited.decided, ['Сначала проверить'])
  assert.notEqual(edited.revision, entry.revision)
  assert.match(await journal.readPrompt('ses_test', 'i1'), /only staging/)
})

test('правка модели отклоняет устаревшую пользовательскую версию без потери данных', async (t) => {
  const { api, entry, journal } = await fixture(t)
  await journal.update('ses_test', { id: 'i1' }, { status: 'done' })
  await assert.rejects(api.edit({ sessionID: 'ses_test', id: 'i1', revision: entry.revision, text: 'Моя правка', status: 'open', clarification: '' }), (error) => error instanceof JournalEditError && error.code === 'conflict')
  const saved = (await journal.load('ses_test')).entries[0]
  assert.equal(saved.status, 'done')
  assert.equal(saved.userEdits, undefined)
})

test('две параллельные правки одной версии: одна сохранена, вторая получает конфликт', async (t) => {
  const { api, entry, journal } = await fixture(t)
  const edit = { sessionID: 'ses_test', id: 'i1', revision: entry.revision, text: 'Моя правка', status: 'open', clarification: '' }
  const results = await Promise.allSettled([api.edit(edit), api.edit(edit)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'conflict')
  assert.equal((await journal.load('ses_test')).entries[0].userEdits.length, 1)
})

test('откатанная запись read-only, уточнения от неё не попадают в контекст', async (t) => {
  const { api, entry, journal } = await fixture(t)
  await api.edit({ sessionID: 'ses_test', id: 'i1', revision: entry.revision, text: 'Моя правка', status: 'open', clarification: 'Уточнение' })
  await journal.recordPrompt('ses_test', 'msg_2', 'новое')
  await journal.markReverted('ses_test', ['msg_2'], false)
  const state = await journal.load('ses_test')
  assert.deepEqual(userCorrections(state), [])
  await assert.rejects(api.edit({ sessionID: 'ses_test', id: 'i1', revision: entryRevision(state.entries[0]), text: 'Вернуть', status: 'open', clarification: '' }), (error) => error.code === 'read_only')
})

test('уточнения переживают повторное чтение и входят даже в краткий журнал закрытой записи', async (t) => {
  const { api, entry, root, journal } = await fixture(t)
  await api.edit({ sessionID: 'ses_test', id: 'i1', revision: entry.revision, text: 'Уточнено', status: 'done', clarification: 'Не повторять отправку.' })
  await journal.update('ses_test', { id: 'i1' }, { why: 'Проверено моделью' })
  const restored = await new Journal(root).load('ses_test')
  assert.equal(userCorrections(restored)[0].clarification, 'Не повторять отправку.')
  assert.match(render(restored, 'brief'), /Не повторять отправку/)
})
