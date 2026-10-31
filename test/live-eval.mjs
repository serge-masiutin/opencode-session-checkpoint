// Eval на реальной модели: изолированный OpenCode, провайдер и инструкции пользователя, только этот плагин.
// Запуск: OPENCODE_TEST_TMP=... node test/live-eval.mjs [модель]   (вызовы LLM платные)
// Ключ передаётся ссылкой {file:...}; конфиг, логи и ответы с секретами не печатаются.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (process.env.OPENCODE_ALLOW_PAID_EVAL !== '1') throw new Error('This eval makes paid model calls. Set OPENCODE_ALLOW_PAID_EVAL=1 only after explicit approval.')
const model = process.argv[2] ?? 'claude-opus-5-5'
const realConfigDir = join(homedir(), '.config/opencode')
const real = JSON.parse(await readFile(join(realConfigDir, 'opencode.json'), 'utf8'))
const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'intent-live-'))
const project = join(root, 'project')

// В изолированном HOME «~» указывал бы во временный каталог, поэтому пути к ключу делаем абсолютными.
const absolutize = (value) => JSON.parse(JSON.stringify(value).replaceAll('{file:~/', `{file:${homedir()}/`))
const provider = absolutize(real.providers.litellm)
provider.models = Object.fromEntries(Object.entries(provider.models).filter(([id]) => id === model || id === 'claude-sonnet-5-5'))
const config = {
  model: `litellm/${model}`,
  plugins: [resolve(import.meta.dirname, '..')],
  update: 'disable',
  share: real.share,
  instructions: real.instructions,
  permissions: real.permissions,
  agents: real.agents,
  providers: { litellm: provider },
}
await mkdir(join(root, 'config/opencode'), { recursive: true })
await mkdir(project, { recursive: true })
await writeFile(join(root, 'config/opencode/opencode.json'), JSON.stringify(config), { mode: 0o600 })
await symlink(join(realConfigDir, 'AGENTS.md'), join(root, 'config/opencode/AGENTS.md'))

const reservation = createServer()
await new Promise((done) => reservation.listen(0, '127.0.0.1', done))
const port = reservation.address().port
await new Promise((done) => reservation.close(done))
const log = []
const server = spawn('/opt/homebrew/bin/opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: project,
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
  if (!response.ok) throw new Error(`API ${path}: ${response.status} ${text.slice(0, 300)}`)
  return text === '' ? undefined : JSON.parse(text)
}

const notes = (id) => join(root, '.local/share/opencode/session-notes', id)
const loadJournal = async (id) => JSON.parse(await readFile(join(notes(id), 'intent.json'), 'utf8'))
const context = async (id) => (await api(`/api/session/${id}/context`)).data

// context после сжатия возвращает только хвост, поэтому ждём новый idle по ID, а не по количеству.
let lastIdle
async function settle(id, _unused, label) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const messages = await context(id)
    const idle = messages.findLast((message) => message.type === 'idle')
    if (idle !== undefined && idle.id !== lastIdle && messages.at(-1).type === 'idle') {
      lastIdle = idle.id
      assert.equal(idle.outcome, 'succeeded', `${label}: ${JSON.stringify(idle.error ?? idle).slice(0, 500)}`)
      return messages
    }
    const pending = (await api(`/api/session/${id}/permission`)).data ?? []
    if (pending.length > 0) throw new Error(`${label}: модель запросила разрешение ${JSON.stringify(pending).slice(0, 300)}`)
    await delay(1000)
  }
  throw new Error(`Timeout: ${label}`)
}

const toolCalls = (messages, from) => messages.slice(from).filter((message) => message.type === 'assistant')
  .flatMap((message) => message.content.filter((part) => part.type === 'tool').map((part) => ({ name: part.name, input: part.state.input, status: part.state.status })))
const answerText = (messages) => messages.findLast((message) => message.type === 'assistant' && message.content.some((part) => part.type === 'text'))
  ?.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? ''

const results = []
const check = (turn, name, ok, detail = '') => results.push({ turn, name, ok: Boolean(ok), detail })

const LONG = [
  'Теперь контекст для следующего шага, прочитай внимательно.',
  ...Array.from({ length: 25 }, (_, index) => `Пункт ${index + 1}: это фоновое описание проекта, оно не содержит новых требований, просто справка о том, как мы обычно ведём файлы и почему порядок строк не важен.`),
  'ВАЖНО: в veg.txt все названия должны быть строго строчными буквами, без заглавных. Исправь файл, если нужно.',
  ...Array.from({ length: 10 }, (_, index) => `Дополнение ${index + 1}: ещё немного справочного текста без требований.`),
].join('\n')

const turns = [
  { label: 'задача', text: 'Создай в текущем каталоге файл notes.txt со списком из трёх фруктов, по одному на строке. git не используй.' },
  { label: 'смена решения', text: 'Передумал: вместо фруктов нужны три овоща, и файл должен называться veg.txt. notes.txt удали.' },
  { label: 'короткая реплика', text: 'ок' },
  { label: 'длинное сообщение', text: LONG },
  { label: 'отложить', text: 'Проверку орфографии в veg.txt сделаем потом, сейчас не надо. На сегодня всё по файлу.' },
]

try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { await api('/api/info'); break } catch (error) {
      if (server.exitCode !== null || attempt === 149) throw error
      await delay(200)
    }
  }
  const id = (await api('/api/session', { title: 'intent live eval', location: { directory: project } })).data.id
  let idle = 0
  let seen = 0
  for (const [index, turn] of turns.entries()) {
    const n = index + 1
    await api(`/api/session/${id}/prompt`, { text: turn.text })
    const messages = await settle(id, idle, turn.label)
    idle = messages.filter((message) => message.type === 'idle').length
    const calls = toolCalls(messages, seen)
    seen = messages.length
    const journal = await loadJournal(id)
    const entry = journal.entries.find((candidate) => candidate.id === `i${n}`)
    results.push({ turn: n, name: 'журнал после хода', ok: true, detail: JSON.stringify({ calls: calls.filter((call) => call.name.startsWith('intent_')).map((call) => [call.name, call.input]), entries: journal.entries.map(({ id, text, status, why, decided }) => ({ id, text, status, why, decided })), notes: journal.notes }) })
    check(n, 'полный текст сообщения сохранён', (await readFile(join(notes(id), `prompts/i${n}.md`), 'utf8')) === turn.text)
    check(n, 'инструменты журнала без ошибок', calls.filter((call) => call.name.startsWith('intent_')).every((call) => call.status === 'completed'), JSON.stringify(calls.filter((call) => call.status !== 'completed')))
    if (turn.label === 'короткая реплика') check(n, '«ок» не осталось открытой заготовкой', entry.status !== 'open' || entry.text !== '(ждёт сути)', `${entry.text} — ${entry.status}`)
    else check(n, 'модель дописала суть', entry.text !== '(ждёт сути)', `${entry.text} — ${entry.status}`)
    if (turn.label === 'смена решения') check(n, 'фрукты не остались открытыми', journal.entries[0].status !== 'open' || /овощ|veg/i.test(journal.entries[0].text), JSON.stringify(journal.entries[0]))
    if (turn.label === 'длинное сообщение') check(n, 'требование из середины длинного сообщения в журнале', /строчн|нижн|lowercase/i.test(JSON.stringify(journal.entries)), JSON.stringify(entry))
    if (turn.label === 'отложить') check(n, 'отложенное записано', /орфограф/i.test(JSON.stringify(journal)) && (journal.notes.some((note) => note.kind === 'postponed') || journal.entries.some((candidate) => candidate.status === 'postponed')), JSON.stringify({ notes: journal.notes, entry }))
  }
  // Очередь: второе сообщение отправляется, пока модель отвечает на первое.
  {
    const firstText = 'Создай файл fruit.txt с одним словом: яблоко. Перед этим подумай, как лучше назвать файл, и обоснуй выбор.'
    const secondText = 'И ещё: создай файл color.txt со словом синий.'
    await api(`/api/session/${id}/prompt`, { text: firstText })
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await context(id)).some((message) => message.type === 'assistant' && message.time.completed === undefined)) break
      await delay(200)
    }
    await api(`/api/session/${id}/prompt`, { text: secondText, delivery: 'queue' })
    const messages = await settle(id, idle, 'очередь')
    idle = messages.filter((message) => message.type === 'idle').length
    for (let attempt = 0; attempt < 600; attempt++) {
      const latest = await context(id)
      if (latest.at(-1).type === 'idle' && (await api(`/api/session/${id}/inbox`)).data.length === 0) {
        lastIdle = latest.at(-1).id
        break
      }
      await delay(1000)
    }
    idle = (await context(id)).filter((message) => message.type === 'idle').length
    const journal = await loadJournal(id)
    const first = journal.entries.find((entry) => entry.prompt !== undefined && (entry.messageID !== undefined) && entry.id === 'i6')
    const second = journal.entries.find((entry) => entry.id === 'i7')
    const detail = JSON.stringify({ first, second })
    check('очередь', 'запись первого сообщения про fruit.txt', first !== undefined && /fruit|яблок|фрукт/i.test(first.text) && !/color|син/i.test(first.text), detail)
    check('очередь', 'запись второго сообщения про color.txt', second !== undefined && /color|син|цвет/i.test(second.text) && !/fruit|яблок/i.test(second.text), detail)
    check('очередь', 'оба файла созданы', (await readdir(project)).includes('fruit.txt') && (await readdir(project)).includes('color.txt'))
  }

  const before = await loadJournal(id)
  check('итог', 'нет открытых заготовок без сути', before.entries.every((entry) => entry.status !== 'open' || entry.text !== '(ждёт сути)'))
  const veg = await readFile(join(project, 'veg.txt'), 'utf8').catch(() => '')
  check('итог', 'задача выполнена (veg.txt строчными, notes.txt удалён)', veg.trim() !== '' && veg === veg.toLowerCase() && !(await readdir(project)).includes('notes.txt'), JSON.stringify(veg))

  await api(`/api/session/${id}/compact`, {})
  let compaction
  for (let attempt = 0; attempt < 600 && compaction === undefined; attempt++) {
    compaction = (await context(id)).findLast((message) => message.type === 'compaction' && ['completed', 'failed'].includes(message.status))
    if (compaction === undefined) await delay(1000)
  }
  check('сжатие', 'штатная сводка построена', compaction?.status === 'completed', compaction?.status)
  check('сжатие', 'в сводке есть veg.txt и отложенная орфография', /veg/i.test(compaction.summary) && /орфограф/i.test(compaction.summary))

  await api(`/api/session/${id}/prompt`, { text: 'Напомни коротко: что мы сделали, какие требования к файлу действуют и что отложено?' })
  const after = await settle(id, idle, 'после сжатия')
  const answer = answerText(after)
  check('после сжатия', 'ответ помнит строчные буквы', /строчн|нижн/i.test(answer))
  check('после сжатия', 'ответ помнит отложенную орфографию', /орфограф/i.test(answer))
  check('после сжатия', 'ответ не тянет отменённые фрукты как действующие', !/фрукт[^.]*(действ|нужн)/i.test(answer))
  const tokens = after.filter((message) => message.type === 'assistant' && message.tokens !== undefined).map((message) => message.tokens.input + message.tokens.cache.read + message.tokens.cache.write)
  console.log(JSON.stringify({ model, journal: await readFile(join(notes(id), 'intent.md'), 'utf8'), answer, contextAfterCompaction: tokens.at(-1), results }, null, 2))
  const failed = results.filter((result) => !result.ok)
  console.log(`\nИТОГ: ${results.length - failed.length}/${results.length} проверок пройдено`)
  for (const result of failed) console.log(`FAIL [${result.turn}] ${result.name}: ${result.detail}`)
} catch (error) {
  await writeFile(join(root, 'server.log'), log.join('').replace(/server password \S+/g, 'server password [REDACTED]').replace(/Bearer [^\s"']+/g, 'Bearer [REDACTED]'), { mode: 0o600 })
  console.error(`Логи: ${root}/server.log`)
  throw error
} finally {
  server.kill('SIGTERM')
  await rm(join(root, 'config'), { recursive: true, force: true })
}
