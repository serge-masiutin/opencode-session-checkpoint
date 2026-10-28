import { ErrorBoundary, For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { render } from 'solid-js/web'
import { demoEntries } from './fixtures.ts'
import { STATUS_LABELS, applyDemoEdit, selectEntries } from './model.ts'
import type { Entry, Filter, Status, UserEdit } from './model.ts'
import { StatusPicker } from './StatusPicker.tsx'
import './style.css'

type IconName = 'memory' | 'search' | 'arrow' | 'back' | 'edit' | 'copy' | 'check' | 'sun' | 'moon' | 'reset' | 'file' | 'lock'
const paths: Record<IconName, string> = {
  memory: 'M5 3h10a2 2 0 0 1 2 2v12H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm1 0v14M9 7h5M9 10h4',
  search: 'm14 14 4 4M16 9A7 7 0 1 1 2 9a7 7 0 0 1 14 0Z',
  arrow: 'm8 5 5 5-5 5', back: 'm12 5-5 5 5 5M7 10h10',
  edit: 'm13 3 4 4M4 13l-1 4 4-1L17 6a2 2 0 0 0-4-4L4 13Z',
  copy: 'M7 7h10v11H7ZM3 13V3h10', check: 'm4 10 4 4 8-8',
  sun: 'M10 2v2M10 16v2M2 10h2M16 10h2M4 4l2 2m8 8 2 2M4 16l2-2m8-8 2-2M14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M17 12A8 8 0 0 1 8 3a8 8 0 1 0 9 9Z',
  reset: 'M3 7a7 7 0 1 1 0 6M3 2v5h5',
  file: 'M5 2h7l4 4v12H4V2h1Zm7 0v5h4M7 11h6M7 14h5',
  lock: 'M5 9h10v9H5ZM7 9V6a3 3 0 0 1 6 0v3',
}

function Icon(props: { name: IconName }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={paths[props.name]} />
  </svg>
}

function StatusMark(props: { status: Status }) {
  return <span class={`status-mark ${props.status}`} aria-hidden="true">
    {props.status === 'done' ? <Icon name="check" /> : props.status === 'dropped' ? '−' : props.status === 'postponed' ? 'Ⅱ' : ''}
  </span>
}

function Details(props: {
  entry: () => Entry
  onEdit: (editing: boolean) => void
  onBack: () => void
  save: (id: string, revision: number, edit: UserEdit) => void
}) {
  const [editing, setEditing] = createSignal(false)
  const [text, setText] = createSignal('')
  const [status, setStatus] = createSignal<Status>('open')
  const [clarification, setClarification] = createSignal('')
  const [revision, setRevision] = createSignal(0)
  const [error, setError] = createSignal('')
  const [notice, setNotice] = createSignal('')
  const [copied, setCopied] = createSignal(false)
  const hasChanges = () => text().trim() !== props.entry().text || status() !== props.entry().status || clarification().trim() !== ''
  let title!: HTMLHeadingElement
  let editButton!: HTMLButtonElement
  let promptElement!: HTMLPreElement

  function startEdit() {
    setText(props.entry().text)
    setStatus(props.entry().status)
    setClarification('')
    setRevision(props.entry().revision)
    setError('')
    setNotice('')
    setEditing(true)
    props.onEdit(true)
  }

  function cancel() {
    setEditing(false)
    props.onEdit(false)
    setError('')
    editButton.focus()
  }

  function submit(event: SubmitEvent) {
    event.preventDefault()
    try {
      props.save(props.entry().id, revision(), { text: text(), status: status(), clarification: clarification() })
      setEditing(false)
      props.onEdit(false)
      setNotice('Applied in preview.')
      title.focus()
    } catch (failure) {
      // Граница пользовательской операции: ошибка видима, форма и черновик остаются на месте.
      setError(failure instanceof Error ? failure.message : 'Could not apply changes.')
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(props.entry().prompt!)
      setCopied(true)
    } catch {
      // Просмотрщик может не разрешить clipboard: предлагаем явное ручное копирование.
      setNotice('Clipboard unavailable. Select the prompt text to copy it manually.')
      promptElement.focus()
    }
  }

  onCleanup(() => props.onEdit(false))
  onMount(() => title.focus())

  return <article class="detail" aria-label="Entry details">
    <div class="detail-top">
      <button class="icon-button back-button" aria-label="Back to entries" onClick={props.onBack} disabled={editing()}><Icon name="back" /></button>
      <span class="eyebrow"><span class="mono">{props.entry().id}</span></span>
      <span class={`status-label ${props.entry().status}`}><StatusMark status={props.entry().status} />{STATUS_LABELS[props.entry().status]}</span>
    </div>
    <h2 ref={title} tabindex="-1">{props.entry().text}</h2>
    <div class="attribution">
      <span class="avatar">A</span>Agent interpretation
      <Show when={props.entry().edits.length > 0}>
        <span class="attribution-divider">·</span><span>Edited by you</span>
      </Show>
    </div>

    <Show when={notice()}><p class="notice" role="status">{notice()}</p></Show>
    <Show when={props.entry().reverted}><p class="notice">Reverted message · Read-only</p></Show>

    <div class="detail-sections">
      <Show when={props.entry().why.length > 0}>
        <section><h3>Why</h3><For each={props.entry().why}>{(line) => <p>{line}</p>}</For></section>
      </Show>
      <Show when={props.entry().decided.length > 0}>
        <section><h3>Decisions <span class="count">{props.entry().decided.length}</span></h3>
          <ul class="decisions">
            <For each={props.entry().decided}>{(line) => <li><span class="decision-line" aria-hidden="true" />{line}</li>}</For>
          </ul>
        </section>
      </Show>
      <Show when={props.entry().edits.length > 0}>
        <section class="user-edits"><h3>Your edits <span class="count">{props.entry().edits.length}</span></h3>
          <For each={props.entry().edits}>{(edit, index) => <div class="user-edit">
            <div class="edit-heading"><span class="avatar user">Y</span>You<span class="muted">· {index() + 1}</span></div>
            <p>{edit.text}</p>
            <p class="muted">{STATUS_LABELS[edit.status]}</p>
            <Show when={edit.clarification}><p>{edit.clarification}</p></Show>
          </div>}</For>
        </section>
      </Show>

      <section class="prompt-section">
        <Show when={props.entry().prompt !== undefined} fallback={<p class="no-prompt"><Icon name="file" />No linked prompt</p>}>
          <details onToggle={() => setCopied(false)}>
            <summary><Icon name="file" /><span>Original prompt</span><Icon name="arrow" /></summary>
            <div class="prompt-content">
              <div class="prompt-toolbar">
                <span><Icon name="lock" />Read-only</span>
                <button class="text-button" onClick={() => void copyPrompt()}>
                  <Icon name={copied() ? 'check' : 'copy'} />{copied() ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre ref={promptElement} tabindex="0" aria-label="Original prompt">{props.entry().prompt}</pre>
            </div>
          </details>
        </Show>
      </section>
    </div>

    <Show when={!props.entry().reverted}>
      <Show when={editing()} fallback={<div class="detail-actions"><button ref={editButton} class="button" onClick={startEdit}><Icon name="edit" />Edit</button></div>}>
        <form class="edit-form" onSubmit={submit}>
          <div class="form-heading"><h3>Edit entry</h3></div>
          <label for="edit-intent">Summary</label>
          <textarea id="edit-intent" ref={(element) => onMount(() => element.focus())} rows="3" required value={text()} onInput={(event) => setText(event.currentTarget.value)} />
          <label for="edit-status">Status</label>
          <StatusPicker id="edit-status" value={status()} onChange={setStatus} />
          <label for="edit-clarification">Clarification <span class="muted">(optional)</span></label>
          <textarea id="edit-clarification" rows="3" value={clarification()} onInput={(event) => setClarification(event.currentTarget.value)} />
          <Show when={error()}>
            <div class="error-box" role="alert">
              <strong>Changes not applied</strong><p>{error()}</p>
              <Show when={props.entry().revision !== revision()}>
                <p>Current: {props.entry().text}</p>
                <button type="button" class="button" onClick={() => { setRevision(props.entry().revision); setError('') }}>Use current version</button>
              </Show>
            </div>
          </Show>
          <div class="form-actions">
            <button type="button" class="button ghost" onClick={cancel}>Cancel</button>
            <button type="submit" class="button primary" disabled={!hasChanges()}>Apply in preview</button>
          </div>
        </form>
      </Show>
    </Show>
  </article>
}

function App() {
  const [entries, setEntries] = createSignal(demoEntries())
  const [query, setQuery] = createSignal('')
  const [filter, setFilter] = createSignal<Filter>('active')
  const [selected, setSelected] = createSignal<string | undefined>()
  const [editing, setEditing] = createSignal(false)
  const [theme, setTheme] = createSignal<'dark' | 'light'>('dark')
  const [narrow, setNarrow] = createSignal(false)
  const [scenario, setScenario] = createSignal('normal')
  const [saveScenario, setSaveScenario] = createSignal('normal')
  const [navigationWarning, setNavigationWarning] = createSignal(false)
  const visible = createMemo(() => selectEntries(entries(), filter(), query()))
  const activeCount = createMemo(() => entries().filter((entry) => entry.status === 'open').length)
  const decisionsCount = createMemo(() => entries().filter((entry) => entry.decided.length > 0).length)

  function choose(id: string) {
    if (editing()) { setNavigationWarning(true); return }
    setNavigationWarning(false)
    setSelected(id)
  }

  function back() {
    const id = selected()
    setSelected(undefined)
    queueMicrotask(() => document.getElementById(`entry-${id}`)?.focus())
  }

  function reset(nextScenario = 'normal') {
    setSelected(undefined)
    setEditing(false)
    setQuery('')
    setFilter('active')
    setNavigationWarning(false)
    setSaveScenario('normal')
    setEntries(nextScenario === 'empty' ? [] : demoEntries())
    setScenario(nextScenario)
  }

  function save(id: string, revision: number, edit: UserEdit) {
    if (saveScenario() === 'failure') throw new Error('Simulated write failure. Your draft has not been saved. Try again.')
    const entry = entries().find((candidate) => candidate.id === id)!
    if (saveScenario() === 'conflict') {
      setEntries(entries().map((candidate) => candidate.id === id ? { ...candidate, revision: candidate.revision + 1 } : candidate))
      setSaveScenario('normal')
      throw new Error('Simulated conflict: the entry changed while you were editing. Review the current version. Your draft is still in the form.')
    }
    const updated = applyDemoEdit(entry, revision, edit)
    setEntries(entries().map((candidate) => candidate.id === id ? updated : candidate))
  }

  return <div class="preview" data-theme={theme()}>
    <header class="preview-header"><div class="brand"><Icon name="memory" /><strong>Session Checkpoint</strong><span class="preview-label">Preview</span></div><button class="icon-button" aria-label={theme() === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => setTheme(theme() === 'dark' ? 'light' : 'dark')}><Icon name={theme() === 'dark' ? 'sun' : 'moon'} /></button></header>
    <main class="preview-main">
      <div class="preview-controls" aria-label="Preview controls">
        <div class="width-switch" aria-label="Panel width"><button aria-pressed={!narrow()} disabled={editing()} onClick={() => setNarrow(false)}>Wide</button><button aria-pressed={narrow()} disabled={editing()} onClick={() => setNarrow(true)}>Narrow</button></div>
        <label>View<select aria-label="Preview state" disabled={editing()} value={scenario()} onChange={(event) => reset(event.currentTarget.value)}><option value="normal">Populated</option><option value="empty">Empty</option><option value="load-error">Read error</option></select></label>
        <label>Save<select aria-label="Save scenario" value={saveScenario()} onChange={(event) => setSaveScenario(event.currentTarget.value)}><option value="normal">Success</option><option value="conflict">Conflict</option><option value="failure">Write error</option></select></label>
        <button class="icon-button" aria-label="Reset preview" disabled={editing()} onClick={() => reset()}><Icon name="reset" /></button>
      </div>

      <div class="panel-frame" classList={{ narrow: narrow() }}>
        <div class="panel-tabbar"><span class="panel-tab"><Icon name="memory" />Memory</span></div>
        <div class="memory-panel" classList={{ 'has-selection': selected() !== undefined }}>
          <aside class="list-pane" aria-label="Session memory">
            <div class="list-heading"><div><h2>Session memory</h2></div></div>
            <div class="search-field"><Icon name="search" /><input type="search" aria-label="Search entries and prompts" placeholder="Search entries and prompts" value={query()} disabled={editing() || scenario() === 'load-error'} onInput={(event) => { setQuery(event.currentTarget.value); setSelected(undefined) }} /></div>
            <div class="filters" aria-label="Entry filters"><For each={[['active', 'Open'], ['all', 'All'], ['decisions', 'Decisions']] as const}>{([value, label]) => <button aria-pressed={filter() === value} disabled={editing()} onClick={() => { setFilter(value); setSelected(undefined) }}>{label}<span>{value === 'active' ? activeCount() : value === 'all' ? entries().length : decisionsCount()}</span></button>}</For></div>
            <Show when={navigationWarning()}><div class="navigation-warning" role="status">Apply or cancel your edit first.</div></Show>
            <Show when={scenario() !== 'load-error'} fallback={<div class="empty-state" role="alert"><Icon name="file" /><h3>Could not read memory</h3><button class="button" onClick={() => reset()}>Retry</button></div>}>
              <Show when={visible().length > 0} fallback={<div class="empty-state"><Icon name="memory" /><h3>{entries().length === 0 ? 'No entries yet' : 'No results'}</h3><Show when={entries().length > 0}><button class="button ghost" onClick={() => { setQuery(''); setFilter('all') }}>Clear filters</button></Show></div>}>
                <ol class="entries"><For each={visible()}>{(entry) => <li><button id={`entry-${entry.id}`} class="entry" classList={{ selected: selected() === entry.id }} aria-current={selected() === entry.id ? 'true' : undefined} onClick={() => choose(entry.id)}><StatusMark status={entry.status} /><span class="entry-body"><span class="entry-title">{entry.text}</span><span class="entry-meta"><span class="mono">{entry.id}</span><span>·</span>{STATUS_LABELS[entry.status]}<Show when={entry.edits.length > 0}><span class="edit-indicator">Edited</span></Show></span></span><span class="entry-arrow"><Icon name="arrow" /></span></button></li>}</For></ol>
              </Show>
            </Show>
          </aside>
          <div class="detail-pane">
            <Show when={selected()} keyed fallback={<div class="detail-placeholder"><h3>Select an entry</h3></div>}>
              {(id) => <Details entry={() => entries().find((entry) => entry.id === id)!} onEdit={setEditing} onBack={back} save={save} />}
            </Show>
          </div>
        </div>
      </div>
      <footer class="preview-footer">Preview only · Sample data · Changes reset on reload</footer>
    </main>
  </div>
}

const root = document.getElementById('root')
if (root === null) throw new Error('Preview root not found')
render(() => <ErrorBoundary fallback={<main class="preview-fatal"><h1>Could not display preview</h1><p>Reload the page to try again.</p></main>}><App /></ErrorBoundary>, root)
