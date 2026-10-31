import { createMemo } from 'solid-js'

/** @param {() => import('@opencode/plugin/gui').MountedSession} current */
export function targetScope(current) {
  return createMemo(() => {
    const session = current()
    const location = session.location
    if (location === undefined || session.pending) return undefined
    return { key: `${session.key}\n${JSON.stringify(location)}`, id: session.id, location, client: session.server.client }
  })
}
