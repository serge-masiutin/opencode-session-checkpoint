// Очередь сообщений: пользователь пишет, пока модель ещё отвечает. Изолированный OpenCode + локальный провайдер.
// Модель в ответ на ПЕРВОЕ медленно вызывает intent_update без id; к этому моменту ВТОРОЕ уже отправлено.
// Ожидание: правка попадает в запись первого сообщения, второе остаётся заготовкой.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const delivery = process.argv[2] ?? 'queue'
const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'intent-queue-'))
const requests = []
const provider = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  const userTexts = input.messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message.content))
  const firstTurn = !input.messages.some((message) => message.role === 'tool') && userTexts.some((text) => text.includes('ПЕРВОЕ')) && !userTexts.some((text) => text.includes('ВТОРОЕ'))
  requests.push({ firstTurn, users: userTexts.length })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (choices, usage) => ({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices, ...(usage === undefined ? {} : { usage }) })
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  if (firstTurn) {
    // Пока модель «думает», тест отправляет ВТОРОЕ.
    await delay(3000)
    const args = JSON.stringify({ text: 'суть первого' })
    res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'intent_update', arguments: args } }] }, finish_reason: null }]))}\n\n`)
    res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage))}\n\n`)
  } else {
    res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant', content: 'Ок.' }, finish_reason: null }]))}\n\n`)
    res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], usage))}\n\n`)
  }
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
const server = spawn(process.env.OPENCODE_TEST_BIN ?? '/opt/homebrew/bin/opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
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
  const id = (await api('/api/session', { title: 'queue', location: { directory: join(root, 'project') } })).data.id
  const journalPath = join(root, '.local/share/opencode/session-notes', id, 'intent.json')
  await api(`/api/session/${id}/prompt`, { text: 'ПЕРВОЕ: сделай A' })
  for (let attempt = 0; attempt < 100 && !requests.some((request) => request.firstTurn); attempt++) await delay(100)
  await api(`/api/session/${id}/prompt`, { text: 'ВТОРОЕ: сделай B', delivery })
  const journalWhileRunning = JSON.parse(await readFile(journalPath, 'utf8').catch(() => '{"entries":[]}'))
  for (let attempt = 0; attempt < 200; attempt++) {
    const messages = (await api(`/api/session/${id}/context`)).data
    if (messages.filter((message) => message.type === 'idle').length >= 1 && requests.length >= 3) break
    await delay(200)
  }
  await delay(1000)
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  const tool = (await api(`/api/session/${id}/context`)).data.flatMap((message) => message.type === 'assistant' ? message.content : []).find((part) => part.type === 'tool')
  const result = { delivery, prompt2RecordedWhileRunning: journalWhileRunning.entries.length, toolResult: tool?.state, entries: journal.entries.map(({ id, text, messageID }) => ({ id, text, messageID })), requests }
  console.log(JSON.stringify(result, null, 2))
  assert.equal(journal.entries.find((entry) => entry.id === 'i1').text, 'суть первого', 'правка без id попала в запись первого сообщения')
  assert.equal(journal.entries.find((entry) => entry.id === 'i2').text, '(ждёт сути)', 'второе сообщение не затронуто')
  console.log(`PASSED (${delivery})`)
} catch (error) {
  await writeFile(join(root, 'server.log'), log.join('').replace(/server password \S+/g, 'server password [REDACTED]'), { mode: 0o600 })
  console.error(`Логи: ${root}/server.log`)
  throw error
} finally {
  server.kill('SIGTERM')
  await new Promise((done) => provider.close(done))
}
