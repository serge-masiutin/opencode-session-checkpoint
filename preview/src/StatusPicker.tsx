import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { STATUS_LABELS } from './model.ts'
import type { Status } from './model.ts'

/** Меню только для песочницы. В Desktop его заменяет публичный ctx.ui.Menu. */
export function StatusPicker(props: { id: string; value: Status; onChange: (status: Status) => void }) {
  const [open, setOpen] = createSignal(false)
  const [above, setAbove] = createSignal(false)
  const statuses = Object.keys(STATUS_LABELS) as Status[]
  let container!: HTMLDivElement
  let trigger!: HTMLButtonElement
  const options = new Map<Status, HTMLButtonElement>()

  function show() {
    setAbove(window.innerHeight - trigger.getBoundingClientRect().bottom < 180)
    setOpen(true)
    options.get(props.value)!.focus()
  }

  function close() {
    setOpen(false)
    trigger.focus()
  }

  function handleKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && open()) {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (!open()) { show(); return }
    const focused = statuses.findIndex((status) => options.get(status) === document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? statuses.length - 1
      : (focused + (event.key === 'ArrowDown' ? 1 : -1) + statuses.length) % statuses.length
    options.get(statuses[next])!.focus()
  }

  createEffect(() => {
    if (!open()) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    onCleanup(() => document.removeEventListener('pointerdown', outside))
  })

  return <div ref={container} class="status-picker" onKeyDown={handleKey} onFocusOut={(event) => {
    if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) setOpen(false)
  }}>
    <button ref={trigger} id={props.id} class="status-trigger" type="button" aria-haspopup="menu" aria-expanded={open()}
      onClick={() => open() ? close() : show()}>
      <span>{STATUS_LABELS[props.value]}</span><span aria-hidden="true">⌄</span>
    </button>
    <Show when={open()}>
      <div class="status-options" classList={{ above: above() }} role="menu" aria-label="Status">
        <For each={statuses}>{(status) => <button type="button" role="menuitemradio" aria-checked={props.value === status}
          ref={(element) => options.set(status, element)} tabindex="-1"
          onClick={() => { props.onChange(status); close() }}>
          <span>{STATUS_LABELS[status]}</span><span aria-hidden="true">{props.value === status ? '✓' : ''}</span>
        </button>}</For>
      </div>
    </Show>
  </div>
}
