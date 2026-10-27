// Откат сообщений: ПЕРВОЕ, ВТОРОЕ, ТРЕТЬЕ, откат до ВТОРОГО, новое сообщение. Изолированный OpenCode + локальный провайдер.
// Ожидание: записи откатанных ВТОРОГО и ТРЕТЬЕГО закрыты как dropped, ПЕРВОЕ и новое остаются открытыми.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'intent-revert-'))
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
  res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant', content: 'Ок.' }, finish_reason: null }]))}\n\n`)
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
  compaction: { auto: false },
  providers: { fixture: {
    name: 'Local fixture', package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'local-test-not-a-secret' },
    models: { fixture: { limit: { context: 1_000_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } },
  } },
}
await writeFile(join(root, 'config/opencode/opencode.json'), JSON.stringify(config))
const log = []
const server = spawn('/opt/homebrew/bin/opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: join(root, 'project'),
  env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (chunk) => log.push(String(chunk)))
server.stderr.on('data', (chunk) => log.push(String(chunk)))
async function api(path, body) {
  const password = log.join('').match(/server password (\S+)/)?.[1]
  const headers = { 'Content-Type': 'application/json', ...(password === undefined ? {} : { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }) }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  const text = await response.text()
  if (!response.ok) throw new Error(`API ${path}: ${response.status} ${text.slice(0, 1000)}`)
  return text === '' ? undefined : JSON.parse(text)
}
try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { await api('/api/info'); break } catch (error) {
      if (server.exitCode !== null || attempt === 149) throw error
      await delay(200)
    }
  }
  const id = (await api('/api/session', { title: 'revert', location: { directory: join(root, 'project') } })).data.id
  const notes = join(root, '.local/share/opencode/session-notes', id)
  const turn = async (text) => {
    const before = requests.length
    await api(`/api/session/${id}/prompt`, { text })
    for (let a = 0; a < 150 && requests.length === before; a++) await delay(100)
    await delay(800)
  }
  await turn('ПЕРВОЕ: сделай A')
  await turn('ВТОРОЕ: сделай B')
  await turn('ТРЕТЬЕ: сделай C')
  const users = (await api(`/api/session/${id}/context`)).data.filter((m) => m.type === 'user')
  const second = users.find((m) => m.text.includes('ВТОРОЕ'))
  const staged = await api(`/api/session/${id}/revert/stage`, { messageID: second.id })
  const sessionStaged = (await api(`/api/session/${id}`)).data
  const ctxStaged = (await api(`/api/session/${id}/context`)).data
  await turn('ПОСЛЕ_ОТКАТА: сделай D')
  const sessionAfter = (await api(`/api/session/${id}`)).data
  const ctxAfter = (await api(`/api/session/${id}/context`)).data
  console.log(JSON.stringify({
    staged: staged.data, revertStaged: sessionStaged.revert ?? null, revertAfter: sessionAfter.revert ?? null,
    contextUsersStaged: ctxStaged.filter((m) => m.type === 'user').map((m) => m.text),
    contextUsersAfter: ctxAfter.filter((m) => m.type === 'user').map((m) => m.text),
    requests, journal: await readFile(join(notes, 'intent.md'), 'utf8'),
  }, null, 2))
  const statuses = JSON.parse(await readFile(join(notes, 'intent.json'), 'utf8')).entries.map((entry) => entry.status)
  assert.deepEqual(statuses, ['open', 'dropped', 'dropped', 'open'])
  console.log('PASSED')
} catch (error) {
  await writeFile(join(root, 'server.log'), log.join('').replace(/server password \S+/g, 'server password [REDACTED]'), { mode: 0o600 })
  console.error(`Логи: ${root}/server.log`)
  throw error
} finally {
  server.kill('SIGTERM')
  await new Promise((done) => provider.close(done))
}
