import assert from 'node:assert/strict'
import test from 'node:test'
import { demoEntries } from './fixtures.ts'
import { applyDemoEdit, selectEntries } from './model.ts'

test('открытые записи первыми, без изменения исходного порядка остальных', () => {
  const entries = demoEntries().reverse()
  const original = entries.map((entry) => entry.id)
  assert.deepEqual(selectEntries(entries, 'all', '').slice(0, 3).map((entry) => entry.status), ['open', 'open', 'open'])
  assert.deepEqual(entries.map((entry) => entry.id), original)
  assert.equal(selectEntries(entries, 'active', '').length, 3)
  assert.equal(selectEntries(entries, 'decisions', '').length, 3)
})

test('поиск в исходном промпте, решениях и уточнениях, без учёта регистра', () => {
  const entries = demoEntries()
  assert.deepEqual(selectEntries(entries, 'all', '  MAIN  ').map((entry) => entry.id), ['i7'])
  assert.deepEqual(selectEntries(entries, 'decisions', 'боковая').map((entry) => entry.id), ['i6'])
  assert.equal(selectEntries(entries, 'all', 'нет такой строки').length, 0)
  const edited = applyDemoEdit(entries[0], 1, { text: entries[0].text, status: 'open', clarification: 'Только staging' })
  assert.equal(selectEntries([edited], 'all', 'STAGING').length, 1)
  const statusOnly = applyDemoEdit(entries[2], 1, { text: entries[2].text, status: 'done', clarification: '' })
  assert.equal(selectEntries([statusOnly], 'decisions', '').length, 0, 'смена статуса не является решением')
})

test('правка сохраняет исходный промпт, объяснения и авторство, не мутируя запись', () => {
  const entry = demoEntries()[0]
  const before = structuredClone(entry)
  const edited = applyDemoEdit(entry, 1, { text: '  Только подготовить  ', status: 'postponed', clarification: ' Не публиковать ' })
  assert.deepEqual(entry, before)
  assert.equal(edited.text, 'Только подготовить')
  assert.equal(edited.prompt, before.prompt)
  assert.deepEqual(edited.decided, before.decided)
  assert.deepEqual(edited.edits, [{ text: 'Только подготовить', status: 'postponed', clarification: 'Не публиковать' }])
  assert.equal(edited.revision, 2)
})

test('конфликт версии, откат и пустая формулировка не изменяют данные', () => {
  const entries = demoEntries()
  const edit = { text: 'Новая формулировка', status: 'open' as const, clarification: '' }
  assert.throws(() => applyDemoEdit(entries[0], 0, edit), /entry has changed/)
  assert.throws(() => applyDemoEdit(entries[5], 1, edit), /read-only/)
  assert.throws(() => applyDemoEdit(entries[0], 1, { ...edit, text: '  ' }), /Enter a summary/)
  assert.equal(entries[0].revision, 1)
  assert.equal(entries[5].status, 'dropped')
})

test('у служебной записи может не быть исходного промпта', () => {
  assert.equal(demoEntries().at(-1)!.prompt, undefined)
  assert.equal(selectEntries([], 'all', '').length, 0)
})
