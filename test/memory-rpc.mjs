// Реальный HTTP RPC и доставка правок модели. Изолированный HOME, только локальный провайдер.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'checkpoint-rpc-'))
const executable = process.env.OPENCODE_TEST_BIN ?? '/Applications/OpenCode.app/Contents/Resources/opencode-cli'
const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()
const requests = []
const provider = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  requests.push(JSON.parse(body))
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (delta, finish_reason, usage) => ({
    id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta, finish_reason }], ...(usage === undefined ? {} : { usage }),
  })
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Локальный тестовый ответ.' }, null))}\n\n`)
  res.write(`data: ${JSON.stringify(chunk({}, 'stop', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }))}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise((done) => provider.listen(0, '127.0.0.1', done))
const reservation = createServer()
await new Promise((done) => reservation.listen(0, '127.0.0.1', done))
const port = reservation.address().port
await new Promise((done) => reservation.close(done))
const directory = join(root, 'project')
const elsewhere = join(root, 'other')
for (const path of [directory, elsewhere, join(root, 'config/opencode')]) await mkdir(path, { recursive: true })
await writeFile(join(root, 'config/opencode/opencode.json'), JSON.stringify({
  model: 'fixture/fixture', plugins: [resolve(import.meta.dirname, '..')], update: 'disable', compaction: { auto: false },
  providers: { fixture: {
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'local-test-not-a-secret' },
    models: { fixture: { limit: { context: 1_000_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } },
  } },
}))
const log = []
const server = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: directory,
  env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (chunk) => log.push(String(chunk)))
server.stderr.on('data', (chunk) => log.push(String(chunk)))

async function http(path, body) {
  const password = log.join('').match(/server password (\S+)/)?.[1]
  const headers = { 'Content-Type': 'application/json', ...(password === undefined ? {} : { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }) }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json() }
}
async function api(path, body) {
  const result = await http(path, body)
  assert.equal(result.status, 200, JSON.stringify(result))
  return result.body
}
async function until(read, accept, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await read()
    if (accept(result)) return result
    await delay(100)
  }
  throw new Error(`Timeout: ${label}`)
}
const rpc = (method, input, location = directory) => http(`/api/rpc/local-session-checkpoint.memory/${method}?location[directory]=${encodeURIComponent(location)}`, { input })
async function turn(id, text) {
  await api(`/api/session/${id}/prompt`, { text })
  await until(() => api(`/api/session/${id}/context`), (result) => {
    const last = result.data.findLastIndex((message) => message.type === 'user' && message.text === text)
    return last >= 0 && result.data.slice(last + 1).some((message) => message.type === 'assistant' && message.time.completed !== undefined)
  }, text)
}

try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { await api('/api/info'); break } catch (error) {
      if (server.exitCode !== null || attempt === 149) throw error
      await delay(200)
    }
  }
  const session = (await api('/api/session', { title: 'Memory RPC fixture', location: { directory } })).data
  await turn(session.id, 'Исходный промпт. Only staging; не публиковать.')
  const listInput = { sessionID: session.id, query: '', filter: 'all' }
  const initial = await rpc('list', listInput)
  assert.equal(initial.status, 200, JSON.stringify(initial))
  const entry = initial.body.output.entries[0]
  assert.equal(entry.id, 'i1')
  assert.match(entry.revision, /^[a-f0-9]{64}$/)
  assert.equal((await rpc('list', { ...listInput, query: 'STAGING' })).body.output.entries.length, 1)
  const original = await rpc('prompt', { sessionID: session.id, id: 'i1' })
  assert.equal(original.body.output.text, 'Исходный промпт. Only staging; не публиковать.')

  for (const invalid of [
    null, [], {}, { ...listInput, query: null },
    { ...listInput, filter: 'unknown' }, { ...listInput, sessionID: '../escape' },
    { ...listInput, query: 'x'.repeat(257) }, { ...listInput, extra: true },
  ]) assert.equal((await rpc('list', invalid)).status, 400, `schema rejects malformed input: ${JSON.stringify(invalid)}`)
  const edit = { sessionID: session.id, id: entry.id, revision: entry.revision, text: 'Только локальная проверка', status: 'postponed', clarification: 'УТОЧНЕНИЕ_RPC: никаких внешних действий.' }
  for (const invalid of [
    { ...edit, id: '../i1' }, { ...edit, revision: 'z'.repeat(64) },
    { ...edit, text: ' ' }, { ...edit, text: 'x'.repeat(1001) },
    { ...edit, clarification: 'x'.repeat(4001) }, { ...edit, status: 'unknown' },
  ]) assert.equal((await rpc('edit', invalid)).status, 400, 'invalid edit must fail before writing')
  const before = requests.length
  const changed = await rpc('edit', edit)
  assert.equal(changed.status, 200, JSON.stringify(changed))
  assert.equal(changed.body.output.edits[0].clarification, edit.clarification)
  assert.equal(requests.length, before, 'GUI edit does not call the model')
  const conflict = await rpc('edit', edit)
  assert.equal(conflict.status, 400, JSON.stringify(conflict))
  assert.equal(conflict.body.type, 'conflict', JSON.stringify(conflict))
  assert.equal((await rpc('prompt', { sessionID: session.id, id: entry.id })).body.output.text, original.body.output.text)
  await turn(session.id, 'Продолжи проверку.')
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('УТОЧНЕНИЕ_RPC'), 'next request receives user correction')

  const child = (await api('/api/session', { parentID: session.id, title: 'child', location: { directory } })).data
  const childRead = await rpc('list', { ...listInput, sessionID: child.id })
  assert.equal(childRead.status, 400, JSON.stringify(childRead))
  assert.equal(childRead.body.type, 'unavailable', JSON.stringify(childRead))
  // Загрузка второго location не разрешает читать журнал сессии первого.
  await api('/api/session', { title: 'other location', location: { directory: elsewhere } })
  const wrongLocation = await rpc('list', listInput, elsewhere)
  assert.equal(wrongLocation.status, 400, JSON.stringify(wrongLocation))
  assert.equal(wrongLocation.body.type, 'unavailable', JSON.stringify(wrongLocation))
  const journal = JSON.parse(await readFile(join(root, '.local/share/opencode/session-notes', session.id, 'intent.json'), 'utf8'))
  assert.equal(journal.entries[0].userEdits.length, 1)
  const context = (await api(`/api/session/${session.id}/context`)).data
  const firstUser = context.find((message) => message.type === 'user')
  await api(`/api/session/${session.id}/revert/stage`, { messageID: firstUser.id })
  await turn(session.id, 'Новая ветка без прежних уточнений.')
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes('УТОЧНЕНИЕ_RPC'), 'reverted correction excluded')
  const reverted = (await rpc('list', listInput)).body.output.entries.find((item) => item.id === entry.id)
  assert.equal(reverted.reverted, true)
  const readOnly = await rpc('edit', { ...edit, revision: reverted.revision })
  assert.equal(readOnly.status, 400)
  assert.equal(readOnly.body.type, 'read_only')
  const journalPath = join(root, '.local/share/opencode/session-notes', session.id, 'intent.json')
  const saved = await readFile(journalPath, 'utf8')
  await writeFile(journalPath, '{broken')
  const corrupted = await rpc('list', listInput)
  assert.equal(corrupted.status, 400)
  assert.equal(corrupted.body.type, 'unavailable')
  assert.equal(await readFile(journalPath, 'utf8'), '{broken', 'read does not rewrite invalid journal')
  await writeFile(journalPath, saved)
  console.log(JSON.stringify({ version, passed: ['list/search/prompt', 'strict input schemas', 'save and author history', 'revision conflict', 'immutable prompt', 'no extra model call', 'correction in next request', 'child restriction', 'location restriction', 'reverted correction excluded', 'reverted read-only', 'corrupt journal is an error'], requests: requests.length, root }, null, 2))
} catch (error) {
  await writeFile(join(root, 'server.log'), log.join('').replace(/server password \S+/g, 'server password [REDACTED]'), { mode: 0o600 })
  console.error(`Тестовые логи: ${root}/server.log`)
  throw error
} finally {
  server.kill('SIGTERM')
  await new Promise((done) => provider.close(done))
}
