import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { MemoryPanel } from '../../gui/panel'
import '../../gui/panel.css'
import './style.css'

// Реальный MemoryPanel; вместо сети и пользовательских журналов — синтетические данные.
const rpc = {
  list: async ({ sessionID }: { sessionID: string }) => ({ entries: [{ id: 'i1', text: `Entry: ${sessionID}`, status: 'open', why: [], decided: [], edits: [], hasPrompt: false, reverted: false, revision: 'fixture' }], notes: [{ id: 'n1', at: null, kind: 'blocker', text: 'Fixture blocker' }], counts: { open: 1, all: 1, decisions: 0 } }),
  dismiss: async () => { throw new Error('Fixture dismiss failure') },
  events: { on: () => () => {} },
}
const ui = {
  Button: (props: any) => <button type={props.type ?? 'button'} disabled={props.disabled || props.busy} onClick={props.onClick}>{props.children}</button>,
  TextInput: (props: any) => <input type="search" aria-label={props.label} placeholder={props.placeholder} disabled={props.disabled}
    value={props.value} onInput={(e) => props.onInput(e.currentTarget.value)} />,
  Loader: () => <span>Loading…</span>, Icon: () => <span aria-hidden="true">!</span>,
}
const client = { rpc: () => rpc }
const makeSession = (id: string) => ({ key: id, id, location: { directory: '/fixture' }, pending: false, server: { client } })
const [session, setSession] = createSignal(makeSession('ses_a'))
const ctx = { ui }
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') ?? 'light'
render(() => <><button onClick={() => setSession(makeSession(session().id === 'ses_a' ? 'ses_b' : 'ses_a'))}>Switch session</button>
  <div class="fixture-panel"><MemoryPanel ctx={ctx as any} session={session() as any} drafts={new Map()} /></div></>, document.getElementById('app')!)
