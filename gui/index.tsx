import { Command, MenuItem, Panel, Plugin, Style } from '@opencode/plugin/gui'
import type { PanelTab } from '@opencode/plugin/gui'
import { MemoryPanel } from './panel'
import type { Draft } from './panel'
import css from './panel.css?inline'

export default Plugin.define({
  setup(ctx) {
    // Только несохранённые правки; исходные промпты не дублируются в хранилище GUI.
    const drafts = new Map<string, Draft>()
    const tab: PanelTab = { id: 'memory', title: 'Memory', closable: 'compact' }
    ctx.add(Style, css)
    ctx.add(Panel, {
      id: 'memory', region: 'side',
      mobile: { title: 'Memory', order: 45, kind: 'menu', icon: 'brain' },
      list: ({ open }) => open.includes('memory') ? [tab] : [],
      render: (props) => <MemoryPanel ctx={ctx} session={props.session} drafts={drafts} />,
    })
    ctx.add(Command, (): Command => ({
      id: 'memory', title: 'Open memory', section: 'session', keywords: 'checkpoint journal prompts',
      enabled: !!ctx.sessions.current(),
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:memory`, session)
      },
    }))
    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current()
      return {
        id: 'memory', menu: 'session.panel', title: 'Memory', icon: 'brain',
        opened: !!session && ctx.layout.state(`${ctx.id}:memory`, session) !== 'closed',
        run: () => { if (session) ctx.layout.open(`${ctx.id}:memory`, session) },
      }
    })
    return () => drafts.clear()
  },
})
