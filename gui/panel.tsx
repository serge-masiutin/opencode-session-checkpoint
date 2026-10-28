import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { Context, MountedSession } from '@opencode/plugin/gui'
import { Memory } from '../rpc'
import type { Filter, MemoryEntry, MemorySnapshot, Status } from '../rpc'

const statuses: Record<Status, string> = { open: 'Open', done: 'Done', postponed: 'Deferred', dropped: 'Dropped' }
const filters: Record<Filter, string> = { open: 'Open', all: 'All', decisions: 'Decisions' }
const noteLabels = { blocker: 'Blocker', dropped: 'Dropped', postponed: 'Deferred' }
export interface Draft { id: string; revision: string; text: string; status: Status; clarification: string }
type Props = { ctx: Context; session: MountedSession; drafts: Map<string, Draft> }

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not access memory. Try again.'
}

export function MemoryPanel(props: Props) {
  // Перемонтирование принадлежит полному RPC scope, а не только sessionID: сервер может переподключиться.
  const scope = createMemo(() => {
    const session = props.session
    const location = session.location
    if (location === undefined || session.pending) return undefined
    return { key: `${session.key}\n${JSON.stringify(location)}`, id: session.id, location, client: session.server.client }
  })
  return <div class="checkpoint-memory">
    <ErrorBoundary fallback={(_, reset) => <div role="alert">Could not display memory. <props.ctx.ui.Button onClick={reset}>Retry</props.ctx.ui.Button></div>}>
      <Show when={scope()} keyed fallback={<p role="status">Waiting for session…</p>}>
        {(target) => <SessionMemory ctx={props.ctx} target={target} drafts={props.drafts} />}
      </Show>
    </ErrorBoundary>
  </div>
}

interface Target {
  key: string
  id: string
  location: NonNullable<MountedSession['location']>
  client: MountedSession['server']['client']
}

function SessionMemory(props: { ctx: Context; target: Target; drafts: Map<string, Draft> }) {
  const { ctx, target, drafts } = props
  const rpc = target.client.rpc(Memory)
  const [query, setQuery] = createSignal('')
  const [filter, setFilter] = createSignal<Filter>('all')
  const [snapshot, setSnapshot] = createSignal<MemorySnapshot>()
  const [error, setError] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)
  const savedDraft = drafts.get(target.key)
  const [selected, setSelected] = createSignal<string | undefined>(savedDraft?.id)
  const [draft, setDraft] = createSignal<Draft | undefined>(savedDraft)
  const [notice, setNotice] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  const lifetime = new AbortController()
  let root!: HTMLDivElement
  let focusFrame: number | undefined
  onCleanup(() => {
    lifetime.abort()
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
  })
  const reload = () => setRefresh((version) => version + 1)

  createEffect(() => {
    const input = { sessionID: target.id, query: query(), filter: filter() }
    refresh()
    const request = new AbortController()
    setLoading(true)
    setError('')
    // Ответ проверяется сервером по output-схеме RPC. JSON Schema в SDK имеет TS-тип unknown.
    void rpc.list(input, { location: target.location, signal: request.signal }).then((result) => {
      if (!request.signal.aborted) setSnapshot(result as MemorySnapshot)
    }).catch((cause: unknown) => {
      if (!request.signal.aborted) setError(failureMessage(cause))
    }).finally(() => {
      if (!request.signal.aborted) setLoading(false)
    })
    onCleanup(() => request.abort())
  })

  createEffect(() => {
    const unsubscribe = rpc.events.on('updated', (event) => {
      const changed = event.data as { sessionID: string }
      if (changed.sessionID === target.id && event.location.directory === target.location.directory) reload()
    }, { signal: lifetime.signal })
    onCleanup(unsubscribe)
  })

  function updateDraft(change: Partial<Draft>) {
    const current = draft()
    if (current === undefined) throw new Error('No active edit')
    const next = { ...current, ...change }
    drafts.set(target.key, next)
    setDraft(next)
  }

  function edit(entry: MemoryEntry) {
    const next: Draft = { id: entry.id, revision: entry.revision, text: entry.text, status: entry.status, clarification: '' }
    drafts.set(target.key, next)
    setDraft(next)
    setNotice('')
  }

  function cancel() {
    drafts.delete(target.key)
    setDraft(undefined)
    setNotice('')
  }

  async function save() {
    const change = draft()
    if (change === undefined || saving()) return
    setSaving(true)
    setNotice('')
    try {
      await rpc.edit({ sessionID: target.id, ...change }, { location: target.location, signal: lifetime.signal })
      if (lifetime.signal.aborted) return
      cancel()
      setNotice('Saved')
      reload()
    } catch (cause) {
      // При уходе со страницы запрос мог сохраниться. Черновик остаётся; повторная запись проверит revision.
      if (lifetime.signal.aborted) return
      setNotice(failureMessage(cause))
      reload()
    } finally {
      if (!lifetime.signal.aborted) setSaving(false)
    }
  }

  const entry = createMemo(() => snapshot()?.entries.find((candidate) => candidate.id === selected()))
  function back() {
    const id = selected()
    setSelected(undefined)
    onNextFrame(() => root.querySelector<HTMLButtonElement>(`[data-entry="${id}"]`)?.focus())
  }
  function onNextFrame(action: () => void) {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => { focusFrame = undefined; action() })
  }

  return <div ref={root} class="checkpoint-body" classList={{ 'has-selection': selected() !== undefined }}>
    <aside class="checkpoint-list" aria-label="Session memory">
      <div class="checkpoint-toolbar">
        <ctx.ui.TextInput label="Search entries and prompts" placeholder="Search entries and prompts" type="search"
          value={query()} disabled={draft() !== undefined} onInput={(value) => {
            setQuery(value.slice(0, 256)); setSelected(undefined)
          }} />
        <ctx.ui.Button size="small" variant="ghost-muted" disabled={loading()} onClick={reload}>Refresh</ctx.ui.Button>
      </div>
      <div class="checkpoint-filters" aria-label="Entry filters">
        <For each={Object.entries(filters) as [Filter, string][]}>{([value, label]) =>
          <ctx.ui.Button size="small" variant={filter() === value ? 'neutral' : 'ghost-muted'} disabled={draft() !== undefined}
            onClick={() => { setFilter(value); setSelected(undefined) }}>{label} {snapshot()?.counts[value]}</ctx.ui.Button>
        }</For>
      </div>
      <Show when={loading()}><span class="checkpoint-state" role="status"><ctx.ui.Loader />Loading…</span></Show>
      <Show when={error()}><div class="checkpoint-error" role="alert">{error()} <ctx.ui.Button onClick={reload}>Retry</ctx.ui.Button></div></Show>
      <Show when={snapshot()}>{(value) => <>
        <Show when={value().entries.length > 0} fallback={<Show when={!loading() && !error()}><p class="checkpoint-state">{value().counts.all === 0 ? 'No entries yet' : 'No results'}</p></Show>}>
          <ol class="checkpoint-entries"><For each={value().entries}>{(item) => <li>
            <button type="button" class="checkpoint-entry" data-entry={item.id} aria-current={selected() === item.id ? 'true' : undefined}
              disabled={draft() !== undefined && draft()!.id !== item.id} onClick={() => { setSelected(item.id); setNotice('') }}>
              <span class="checkpoint-dot" data-status={item.status} />
              <span><span class="checkpoint-title">{item.text}</span><span class="checkpoint-meta">{item.id} · {statuses[item.status]}{item.reverted ? ' · Reverted' : ''}{item.edits.length > 0 ? ' · Edited' : ''}</span></span>
            </button>
          </li>}</For></ol>
        </Show>
        <Show when={value().notes.length > 0}><section class="checkpoint-notes" aria-label="Notes"><For each={value().notes}>{(note) => <p><strong>{noteLabels[note.kind]}</strong> {note.text}</p>}</For></section></Show>
      </>}</Show>
    </aside>
    <main class="checkpoint-detail">
      <Show when={selected()} fallback={<p class="checkpoint-state">Select an entry</p>}>
        <ctx.ui.Button size="small" variant="ghost-muted" disabled={draft() !== undefined} onClick={back}>Back to entries</ctx.ui.Button>
        <Show when={entry()} fallback={<p role="status">{loading() ? 'Loading…' : 'Entry not in this view. Refresh or cancel your edit.'}</p>}>{(current) => <>
          <EntryDetails ctx={ctx} entry={current()} target={target} />
          <Show when={current().reverted}><p class="checkpoint-meta">Reverted message · Read-only</p></Show>
          <Show when={!current().reverted && draft() === undefined}><ctx.ui.Button icon="edit" onClick={() => edit(current())}>Edit</ctx.ui.Button></Show>
        </>}</Show>
        <Show when={draft()}>{(change) => <form class="checkpoint-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <h3>Edit entry</h3>
          <label>Summary<textarea rows="3" required maxLength={1000} disabled={saving()} value={change().text}
            ref={(element) => onMount(() => element.focus())} onInput={(event) => updateDraft({ text: event.currentTarget.value })} /></label>
          <div><span class="checkpoint-label">Status</span><ctx.ui.Menu label={statuses[change().status]} trigger="button" placement="bottom-start" disabled={saving()}
            items={(Object.keys(statuses) as Status[]).map((status) => ({ label: statuses[status], icon: status === change().status ? 'check' : undefined, onSelect: () => updateDraft({ status }) }))} /></div>
          <label>Clarification (optional)<textarea rows="3" maxLength={4000} disabled={saving()} value={change().clarification} onInput={(event) => updateDraft({ clarification: event.currentTarget.value })} /></label>
          <Show when={entry() && entry()!.revision !== change().revision}>
            <div class="checkpoint-error" role="alert"><p>This entry changed. Review the current summary and status before saving.</p>
              <ctx.ui.Button disabled={saving() || entry()!.reverted} onClick={() => updateDraft({ revision: entry()!.revision })}>Use current version</ctx.ui.Button>
            </div>
          </Show>
          <div class="checkpoint-actions"><ctx.ui.Button disabled={saving()} onClick={cancel}>Cancel</ctx.ui.Button>
            <ctx.ui.Button type="submit" variant="contrast" busy={saving()} disabled={!entry() || entry()!.reverted || entry()!.revision !== change().revision || change().text.trim() === '' || (change().text.trim() === entry()!.text && change().status === entry()!.status && change().clarification.trim() === '')}>Save</ctx.ui.Button></div>
        </form>}</Show>
        <Show when={notice()}><p role="status" class="checkpoint-notice">{notice()}</p></Show>
      </Show>
    </main>
  </div>
}

function EntryDetails(props: { ctx: Context; entry: MemoryEntry; target: Target }) {
  const { ctx } = props
  return <Show when={props.entry.id} keyed>{(_id) => {
    const [prompt, setPrompt] = createSignal<string>()
    const [error, setError] = createSignal('')
    const [loading, setLoading] = createSignal(false)
    const [copied, setCopied] = createSignal(false)
    const lifetime = new AbortController()
    let title!: HTMLHeadingElement
    onMount(() => title.focus())
    onCleanup(() => lifetime.abort())
    async function loadPrompt() {
      if (prompt() !== undefined || loading()) return
      setLoading(true); setError('')
      try {
        const result = await props.target.client.rpc(Memory).prompt({ sessionID: props.target.id, id: props.entry.id }, { location: props.target.location, signal: lifetime.signal }) as { text: string }
        if (!lifetime.signal.aborted) setPrompt(result.text)
      } catch (cause) {
        if (!lifetime.signal.aborted) setError(failureMessage(cause))
      } finally {
        if (!lifetime.signal.aborted) setLoading(false)
      }
    }
    async function copy() {
      try {
        await ctx.system.copy(prompt()!)
        if (!lifetime.signal.aborted) setCopied(true)
      } catch {
        if (!lifetime.signal.aborted) setError('Could not copy. Select the prompt text to copy it manually.')
      }
    }
    return <article>
      <p class="checkpoint-meta">{props.entry.id} · {statuses[props.entry.status]}</p>
      <h2 ref={title} tabindex="-1">{props.entry.text}</h2>
      <p class="checkpoint-meta">Agent interpretation{props.entry.edits.length > 0 ? ' · Edited by you' : ''}</p>
      <Show when={props.entry.why.length > 0}><section><h3>Why</h3><For each={props.entry.why}>{(line) => <p>{line}</p>}</For></section></Show>
      <Show when={props.entry.decided.length > 0}><section><h3>Decisions</h3><ul><For each={props.entry.decided}>{(line) => <li>{line}</li>}</For></ul></section></Show>
      <Show when={props.entry.edits.length > 0}><section><h3>Your edits</h3><For each={props.entry.edits}>{(edit) => <div class="checkpoint-edit"><p class="checkpoint-meta">You · {edit.at}</p><p>{edit.text}</p><p class="checkpoint-meta">{statuses[edit.status]}</p><Show when={edit.clarification}><p>{edit.clarification}</p></Show></div>}</For></section></Show>
      <Show when={props.entry.hasPrompt} fallback={<p class="checkpoint-meta">No linked prompt</p>}>
        <details onToggle={(event) => { if (event.currentTarget.open) void loadPrompt() }}><summary>Original prompt</summary>
          <Show when={loading()}><ctx.ui.Loader /></Show>
          <Show when={error()}><p role="alert">{error()} <ctx.ui.Button onClick={() => void loadPrompt()}>Retry</ctx.ui.Button></p></Show>
          <Show when={prompt() !== undefined}><div class="checkpoint-actions"><span class="checkpoint-meta">Read-only</span><ctx.ui.Button size="small" variant="ghost-muted" onClick={() => void copy()}>{copied() ? 'Copied' : 'Copy'}</ctx.ui.Button></div><pre tabindex="0" aria-label="Original prompt">{prompt()}</pre></Show>
        </details>
      </Show>
    </article>
  }}</Show>
}
