// Изолированный OpenCode + локальный HTTP-провайдер. Никаких API-ключей и реальных LLM-вызовов.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'checkpoint-integration-'))
const executable = process.env.OPENCODE_TEST_BIN ?? '/opt/homebrew/bin/opencode'
const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()
const fixture = '## Objective\nПроверить alpha.txt.\n\n## Requirements\n- Нельзя push.\n\n## Decisions\n- Отправка уже выполнена.\n\n## Work State\n### Completed\n- Отправка.\n### Active\n- Проверка alpha.txt.\n### Blocked\n- Нет.\n\n## Next Move\n1. Проверить alpha.txt.\n\n## Relevant Files\n- alpha.txt: цель.\n\n## Important Context\n- ' + 'длинный контекст '.repeat(600)
const requests = []
const pressure = Number(process.argv[2] ?? 0)
let childPressure = false
const provider = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  const all = JSON.stringify(input.messages)
  const summary = all.includes('<template>') && all.includes('## Objective')
  const pressured = all.includes('Контекст скоро будет сжат') && !all.includes('"role":"tool"')
  requests.push({
    summary, pressured,
    tools: (input.tools ?? []).map((tool) => tool.function.name).filter((name) => name.startsWith('intent_')),
    journalInSummary: summary && all.includes('проверить alpha.txt') && all.includes('без push'),
    journalInstruction: all.includes('Журнал намерений пользователя') || all.includes('<intent-journal>'),
    restored: all.includes('Контекст был сжат'),
    promptLeak: !summary && all.includes('Запомни: нужно проверить') && all.includes('<intent-journal>'),
  })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (choices, usage) => ({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices, ...(usage === undefined ? {} : { usage }) })
  const inputTokens = childPressure ? 300_000 : requests.length === 1 && pressure > 0 ? pressure : 100
  childPressure = false
  const usage = { prompt_tokens: inputTokens, completion_tokens: 20, total_tokens: inputTokens + 20 }
  if (pressured) {
    const args = JSON.stringify({ id: 'i1', text: 'проверить alpha.txt', decided: 'без push' })
    res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'intent_update', arguments: args } }] }, finish_reason: null }]))}\n\n`)
    res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage))}\n\n`)
  } else {
    const text = summary ? fixture : 'Тестовый ответ: alpha.txt, без push.'
    res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]))}\n\n`)
    res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], usage))}\n\n`)
  }
  res.end('data: [DONE]\n\n')
})
await new Promise((done) => provider.listen(0, '127.0.0.1', done))
const providerPort = provider.address().port
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
    settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'local-test-not-a-secret' },
    models: { fixture: { limit: { context: 1_000_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } },
  } },
}
await writeFile(join(root, 'config/opencode/opencode.json'), JSON.stringify(config))
await writeFile(join(root, 'project/opencode.json'), JSON.stringify(config))
const log = []
const server = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
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
async function until(read, accept, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await read()
    if (accept(result)) return result
    await delay(200)
  }
  throw new Error(`Timeout: ${label}`)
}
try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { await api('/api/info'); break } catch (error) {
      if (server.exitCode !== null || attempt === 149) throw error
      await delay(200)
    }
  }
  const created = await api('/api/session', { title: 'Checkpoint isolated fixture', location: { directory: join(root, 'project') } })
  const id = created.data.id
  await api(`/api/session/${id}/prompt`, { text: 'Запомни: нужно проверить alpha.txt. Нельзя push. Отправка выполнена, не повторять. ' + 'подробности '.repeat(600) })
  const plugins = await until(() => api(`/api/plugin?location[directory]=${encodeURIComponent(join(root, 'project'))}`), (r) => r.data.some((entry) => entry.id === 'local-session-checkpoint'), 'plugin activation')
  await until(() => api(`/api/session/${id}/context`), (r) => r.data.some((m) => m.type === 'assistant' && m.time.completed !== undefined), 'first response')
  if (pressure === 0) await api(`/api/session/${id}/compact`, {})
  else await api(`/api/session/${id}/prompt`, { text: 'Продолжи проверку alpha.txt, без push.' })
  const compacted = await until(() => api(`/api/session/${id}/context`), (r) => r.data.some((m) => m.type === 'compaction' && ['completed', 'failed'].includes(m.status)), 'compaction')
  const compact = compacted.data.findLast((m) => m.type === 'compaction')
  assert.equal(compact.status, 'completed', JSON.stringify(compact))
  const notes = join(root, '.local/share/opencode/session-notes', id)
  const longPrompt = await readFile(join(notes, 'prompts/i1.md'), 'utf8')
  assert.ok(longPrompt.startsWith('Запомни: нужно проверить alpha.txt') && longPrompt.length > 5000, 'полный текст сообщения сохранён')
  if (pressure === 0) await api(`/api/session/${id}/prompt`, { text: 'Продолжи' })
  await until(async () => requests, (r) => r.some((request) => request.restored), 'restored response')
  const journal = await readFile(join(notes, 'intent.md'), 'utf8')
  assert.equal(requests.filter((request) => request.summary).length, 1, JSON.stringify(requests))
  assert.ok(requests.every((request) => request.summary || request.tools.join() === 'intent_note,intent_update'), JSON.stringify(requests))
  assert.ok(!requests.some((request) => request.promptLeak), 'полный текст не попадает в обычный контекст')
  if (pressure > 0) {
    assert.ok(requests.some((request) => request.pressured), 'было напоминание о сжатии')
    assert.ok(journal.includes('- [i1] проверить alpha.txt → prompts/i1.md — open') && journal.includes('**I decided:** без push'), journal)
    assert.ok(requests.find((request) => request.summary).journalInSummary, 'запись модели попала в запрос сводки')
  }
  const before = requests.length
  const summariesBeforeChild = requests.filter((request) => request.summary).length
  const child = (await api('/api/session', { parentID: id, title: 'child', location: { directory: join(root, 'project') } })).data.id
  childPressure = true
  await api(`/api/session/${child}/prompt`, { text: 'Задача подагенту' })
  await until(async () => requests, (r) => r.length > before, 'child response')
  assert.deepEqual(requests.at(-1).tools, [], 'у подагента нет инструментов журнала')
  await until(() => api(`/api/session/${child}/context`), (r) => r.data.some((m) => m.type === 'assistant' && m.time.completed !== undefined && m.tokens?.input === 300_000), 'child usage')
  await api(`/api/session/${child}/prompt`, { text: 'Продолжи задачу.' })
  const childMessages = await until(() => api(`/api/session/${child}/context`), (r) => r.data.some((m) => m.type === 'compaction' && ['completed', 'failed'].includes(m.status)), 'child compaction')
  const childCompaction = childMessages.data.findLast((m) => m.type === 'compaction')
  assert.equal(childCompaction.status, 'completed', JSON.stringify(childCompaction.error))
  const childSummaries = requests.filter((request) => request.summary).slice(summariesBeforeChild)
  assert.equal(childSummaries.length, 1, 'одна сводка подагента')
  assert.deepEqual(childSummaries[0].tools, [], 'в запросе сводки нет инструментов журнала')
  assert.equal(childSummaries[0].journalInSummary, false, 'в сводке нет пользовательского журнала')
  assert.ok(requests.slice(before).every((request) => !request.journalInstruction), 'у подагента нет инструкций и содержимого журнала')
  await assert.rejects(readFile(join(root, '.local/share/opencode/session-notes', child, 'intent.json')), { code: 'ENOENT' })
  console.log(JSON.stringify({ passed: true, version, pressure, root, requests, journal }, null, 2))
} catch (error) {
  await writeFile(join(root, 'server.log'), log.join('').replace(/server password \S+/g, 'server password [REDACTED]'), { mode: 0o600 })
  console.error(`Тестовые логи (изолированный HOME, без пользовательской конфигурации): ${root}/server.log`)
  throw error
} finally {
  server.kill('SIGTERM')
  await new Promise((done) => provider.close(done))
}
