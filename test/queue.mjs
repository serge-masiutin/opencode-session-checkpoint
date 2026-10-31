// Очередь сообщений: пользователь пишет, пока модель ещё отвечает. Изолированный OpenCode + локальный провайдер.
// Модель в ответ на ПЕРВОЕ медленно вызывает intent_update без id; к этому моменту ВТОРОЕ уже отправлено.
// Ожидание: правка попадает в запись первого сообщения, второе остаётся заготовкой.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const scenario = process.argv[2] ?? 'queue'
assert.ok(['queue', 'steer', 'cancel'].includes(scenario))
const delivery = scenario === 'cancel' ? 'queue' : scenario
const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'intent-queue-'))
const requests = []
let releaseFirst
const firstGate = new Promise((resolve) => { releaseFirst = resolve })
const provider = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  const userTexts = input.messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message.content))
  const firstTurn = !input.messages.some((message) => message.role === 'tool') && userTexts.some((text) => text.includes('ПЕРВОЕ')) && !userTexts.some((text) => text.includes('ВТОРОЕ'))
  const deliveredSecond = userTexts.some((text) => text.includes('ВТОРОЕ'))
  const guidance = JSON.stringify(input.messages.filter((message) => message.role === 'system'))
  requests.push({ firstTurn, users: userTexts.length, deliveredSecond, leakedGuidance: !deliveredSecond && /без сути в журнале:.*i2|ВТОРОЕ/.test(guidance) })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (choices, usage) => ({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices, ...(usage === undefined ? {} : { usage }) })
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  if (firstTurn) {
    // Пока модель «думает», тест отправляет ВТОРОЕ.
    await firstGate
    const calls = [
      { id: 'call_read', args: { id: 'i2', read_prompt: true } },
      { id: 'call_write', args: { id: 'i2', text: 'недопустимая правка' } },
      { id: 'call_current', args: { text: 'суть первого' } },
    ].map((call, index) => ({ index, id: call.id, type: 'function', function: { name: 'intent_update', arguments: JSON.stringify(call.args) } }))
    res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant', tool_calls: calls }, finish_reason: null }]))}\n\n`)
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
  plugins: [resolve(process.env.OPENCODE_CHECKPOINT_PLUGIN ?? resolve(import.meta.dirname, '..'))],
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
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const password = log.join('').match(/server password (\S+)/)?.[1]
  const headers = { 'Content-Type': 'application/json', ...(password === undefined ? {} : { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }) }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
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
  const queued = (await api(`/api/session/${id}/prompt`, { text: 'ВТОРОЕ: сделай B', delivery })).data
  const journalWhileRunning = JSON.parse(await readFile(journalPath, 'utf8').catch(() => '{"entries":[]}'))
  assert.equal(journalWhileRunning.entries.length, 1, 'очередь не должна создавать запись до доставки модели')
  assert.ok(!JSON.stringify(journalWhileRunning).includes(queued.id), 'ID очереди не должен появляться в журнале')
  assert.doesNotMatch(JSON.stringify(journalWhileRunning), /ВТОРОЕ/, 'текст очереди не должен появляться в журнале')
  const journalFolder = join(root, '.local/share/opencode/session-notes', id)
  assert.deepEqual(await readdir(join(journalFolder, 'prompts')), ['i1.md'], 'очередь не должна создавать файл промпта')
  assert.doesNotMatch(await readFile(join(journalFolder, 'intent.md'), 'utf8'), /i2|ВТОРОЕ/, 'очередь не должна появляться в журнале')
  if (scenario === 'cancel') await api(`/api/session/${id}/inbox/${queued.id}`, undefined, 'DELETE')
  releaseFirst()
  for (let attempt = 0; attempt < 200; attempt++) {
    const messages = (await api(`/api/session/${id}/context`)).data
    if (messages.some((message) => message.type === 'idle') && requests.length >= (scenario === 'queue' ? 3 : 2)) break
    await delay(200)
  }
  await delay(1000)
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  const tools = (await api(`/api/session/${id}/context`)).data.flatMap((message) => message.type === 'assistant' ? message.content : []).filter((part) => part.type === 'tool')
  const result = { scenario, prompt2RecordedWhileRunning: journalWhileRunning.entries.length, toolResults: tools.map((tool) => tool.state), entries: journal.entries.map(({ id, text, messageID }) => ({ id, text, messageID })), requests }
  console.log(JSON.stringify(result, null, 2))
  assert.equal(journal.entries.find((entry) => entry.id === 'i1').text, 'суть первого', 'правка без id попала в запись первого сообщения')
  assert.ok(requests.every((request) => !request.leakedGuidance), 'подсказки не раскрывают второе сообщение до доставки')
  assert.equal(tools.filter((tool) => tool.state.status === 'error').length, 2, 'чтение и запись недоставленного i2 отклонены')
  if (scenario === 'cancel') {
    assert.equal(journal.entries.length, 1, 'отменённая очередь не создаёт запись')
    assert.deepEqual(await readdir(join(journalFolder, 'prompts')), ['i1.md'])
    assert.ok(requests.every((request) => !request.deliveredSecond))
  } else {
    assert.equal(journal.entries.length, 2, 'доставленное сообщение записано ровно один раз')
    assert.equal(journal.entries.find((entry) => entry.id === 'i2').text, '(ждёт сути)', 'второе сообщение не затронуто')
    assert.equal(await readFile(join(journalFolder, 'prompts/i2.md'), 'utf8'), 'ВТОРОЕ: сделай B')
    assert.ok(requests.some((request) => request.deliveredSecond))
  }
  console.log(`PASSED (${scenario})`)
} catch (error) {
  await writeFile(join(root, 'server.log'), log.join('').replace(/server password \S+/g, 'server password [REDACTED]'), { mode: 0o600 })
  console.error(`Логи: ${root}/server.log`)
  throw error
} finally {
  releaseFirst()
  server.kill('SIGTERM')
  await new Promise((done) => provider.close(done))
}
