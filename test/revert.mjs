// Rewind, Undo, смена границы и откат после compaction. Изолированный OpenCode + локальный провайдер.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const extended = process.argv[2] === 'after-compact'
assert.ok(process.argv[2] === undefined || extended, 'Аргумент: after-compact или без аргументов')
const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'intent-revert-'))
const executable = process.env.OPENCODE_TEST_BIN ?? '/opt/homebrew/bin/opencode'
const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()
// Реальный OpenCode валидирует шаблон сводки; обычное «Ок.» не является валидной сводкой.
const summary = '## Objective\nТест отката после сжатия.\n\n## Requirements\n- Локальный провайдер.\n\n## Decisions\n- Без внешних действий.\n\n## Work State\n### Completed\n- Первые три хода.\n### Active\n- Проверка отката.\n### Blocked\n- Нет.\n\n## Next Move\n1. Продолжить проверку.\n\n## Relevant Files\n- Нет.\n\n## Important Context\n- ' + 'Тестовый контекст. '.repeat(600)
const requests = []
const provider = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  const all = JSON.stringify(input.messages)
  requests.push({ users: input.messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content).match(/[А-ЯЁ_]{4,}/)?.[0]), pendingNote: all.match(/Сообщения пользователя без сути[^"]*/)?.[0] })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (choices, usage) => ({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices, ...(usage === undefined ? {} : { usage }) })
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  const response = all.includes('Журнал намерений пользователя за сессию') ? summary : 'Ок.'
  res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant', content: response }, finish_reason: null }]))}\n\n`)
  res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], usage))}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise((done) => provider.listen(0, '127.0.0.1', done))
const reservation = createServer()
await new Promise((done) => reservation.listen(0, '127.0.0.1', done))
const port = reservation.address().port
await new Promise((done) => reservation.close(done))
await mkdir(join(root, 'config/opencode'), { recursive: true })
await mkdir(join(root, 'project'), { recursive: true })
const config = {
  model: 'fixture/fixture',
  plugins: [resolve(import.meta.dirname, '..')],
  update: 'disable',
  compaction: { auto: false, keep: { tokens: 0 } },
  providers: { fixture: {
    name: 'Local fixture', package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'local-test-not-a-secret' },
    models: { fixture: { limit: { context: 1_000_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } },
  } },
}
await writeFile(join(root, 'config/opencode/opencode.json'), JSON.stringify(config))
const log = []
const server = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: join(root, 'project'),
  env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (chunk) => log.push(String(chunk)))
server.stderr.on('data', (chunk) => log.push(String(chunk)))
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const password = log.join('').match(/server password (\S+)/)?.[1]
  const headers = { 'Content-Type': 'application/json', ...(password === undefined ? {} : { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }) }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`API ${path}: ${response.status} ${text.slice(0, 1000)}`)
  return text === '' ? undefined : JSON.parse(text)
}

async function until(read, accept, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await read()
    if (accept(result)) return result
    await delay(100)
  }
  throw new Error(`Timeout: ${label}`)
}

const context = async (id) => (await api(`/api/session/${id}/context`)).data
const loadJournal = async (id) => JSON.parse(await readFile(join(root, '.local/share/opencode/session-notes', id, 'intent.json'), 'utf8'))
async function turn(id, text) {
  const before = requests.length
  await api(`/api/session/${id}/prompt`, { text })
  await until(() => context(id), (messages) => {
    const lastUser = messages.findLastIndex((message) => message.type === 'user' && message.text === text)
    return requests.length > before && lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message.type === 'assistant' && message.time.completed !== undefined)
  }, `response: ${text}`)
}

async function seed(title) {
  const id = (await api('/api/session', { title, location: { directory: join(root, 'project') } })).data.id
  for (const text of ['ПЕРВОЕ: сделай A', 'ВТОРОЕ: сделай B', 'ТРЕТЬЕ: сделай C']) await turn(id, text)
  const users = (await context(id)).filter((message) => message.type === 'user')
  return { id, users }
}

async function assertUnchanged(id, before, label) {
  assert.deepEqual(await loadJournal(id), before, label)
}

try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { await api('/api/info'); break } catch (error) {
      if (server.exitCode !== null || attempt === 149) throw error
      await delay(200)
    }
  }
  const passed = []

  const committed = await seed('rewind then continue')
  const original = await loadJournal(committed.id)
  await api(`/api/session/${committed.id}/revert/stage`, { messageID: committed.users[1].id })
  await assertUnchanged(committed.id, original, 'staging rewind не меняет журнал')
  assert.equal((await context(committed.id)).filter((message) => message.type === 'user').length, 3)
  await turn(committed.id, 'ПОСЛЕ_ОТКАТА: сделай D')
  const closed = await loadJournal(committed.id)
  assert.deepEqual(closed.entries.map((entry) => entry.status), ['open', 'dropped', 'dropped', 'open'])
  assert.deepEqual(closed.entries.map((entry) => entry.reverted === true), [false, true, true, false])
  assert.deepEqual(requests.at(-1).users, ['ПЕРВОЕ', 'ПОСЛЕ_ОТКАТА'])
  for (const entry of original.entries) {
    assert.equal(await readFile(join(root, '.local/share/opencode/session-notes', committed.id, entry.prompt), 'utf8'), committed.users[Number(entry.id.slice(1)) - 1].text)
  }
  passed.push('rewind → continue: закрыты только откатанные записи, исходные промпты сохранены')

  const undo = await seed('rewind then Undo')
  const beforeUndo = await loadJournal(undo.id)
  await api(`/api/session/${undo.id}/revert/stage`, { messageID: undo.users[1].id })
  await api(`/api/session/${undo.id}/revert`, undefined, 'DELETE')
  await assertUnchanged(undo.id, beforeUndo, 'Undo не закрывает записи')
  await turn(undo.id, 'ПОСЛЕ_UNDO: продолжи')
  assert.deepEqual((await loadJournal(undo.id)).entries.map((entry) => entry.status), ['open', 'open', 'open', 'open'])
  assert.deepEqual(requests.at(-1).users, ['ПЕРВОЕ', 'ВТОРОЕ', 'ТРЕТЬЕ', 'ПОСЛЕ_'])
  passed.push('rewind → Undo → continue: вся история и открытые записи сохранены')

  const prior = await seed('Undo restores earlier rewind')
  await api(`/api/session/${prior.id}/revert/stage`, { messageID: prior.users[1].id })
  await api(`/api/session/${prior.id}/revert/stage`, { messageID: prior.users[0].id })
  await api(`/api/session/${prior.id}/revert/stage`, { messageID: prior.users[1].id })
  assert.equal((await api(`/api/session/${prior.id}`)).data.revert.messageID, prior.users[1].id)
  await turn(prior.id, 'ВОЗВРАТ_ГРАНИЦЫ: сделай D')
  assert.deepEqual((await loadJournal(prior.id)).entries.map((entry) => entry.status), ['open', 'dropped', 'dropped', 'open'])
  passed.push('Undo к прежней границе: отмена только после восстановленной границы')

  const first = await seed('rewind to first prompt')
  await api(`/api/session/${first.id}/revert/stage`, { messageID: first.users[0].id })
  await turn(first.id, 'НОВОЕ: начни заново')
  assert.deepEqual((await loadJournal(first.id)).entries.map((entry) => entry.status), ['dropped', 'dropped', 'dropped', 'open'])
  assert.deepEqual(requests.at(-1).users, ['НОВОЕ'])
  passed.push('rewind к первому сообщению: старые записи закрыты')

  if (extended) {
    const compacted = await seed('rewind after compaction')
    await api(`/api/session/${compacted.id}/compact`, {})
    await until(() => context(compacted.id), (messages) => messages.some((message) => message.type === 'compaction' && ['completed', 'failed'].includes(message.status)), 'compaction')
    const compaction = (await context(compacted.id)).findLast((message) => message.type === 'compaction')
    assert.equal(compaction.status, 'completed', JSON.stringify(compaction))
    await turn(compacted.id, 'ПОСЛЕ_СЖАТИЯ: сделай D')
    await turn(compacted.id, 'СЛЕДУЮЩЕЕ: сделай E')
    const boundary = (await context(compacted.id)).find((message) => message.type === 'user' && message.text.startsWith('ПОСЛЕ_СЖАТИЯ'))
    await api(`/api/session/${compacted.id}/revert/stage`, { messageID: boundary.id })
    await turn(compacted.id, 'НОВАЯ_ВЕТКА: сделай F')
    assert.deepEqual((await loadJournal(compacted.id)).entries.map((entry) => entry.status), ['open', 'open', 'open', 'dropped', 'dropped', 'open'])
    passed.push('rewind после сжатия: старые записи не приняты за откатанные, новые отменены корректно')
  }

  console.log(JSON.stringify({ version, passed, requests: requests.length, root }, null, 2))
} catch (error) {
  await writeFile(join(root, 'server.log'), log.join('').replace(/server password \S+/g, 'server password [REDACTED]'), { mode: 0o600 })
  console.error(`Логи: ${root}/server.log`)
  throw error
} finally {
  server.kill('SIGTERM')
  await new Promise((done) => provider.close(done))
}
