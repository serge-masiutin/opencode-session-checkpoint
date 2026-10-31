import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('scope реагирует на замену routed session без перемонтирования родителя', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { createRoot, createSignal } from 'solid-js'
    import { targetScope } from './gui/target-scope.mjs'
    createRoot((dispose) => {
      const a = { key: 'A', id: 'ses_A', location: { directory: '/a' }, pending: false, server: { client: 'clientA' } }
      const b = { key: 'B', id: 'ses_B', location: { directory: '/b' }, pending: false, server: { client: 'clientB' } }
      const [session, setSession] = createSignal(a)
      const scope = targetScope(session)
      assert.equal(scope().id, 'ses_A')
      const firstKey = scope().key
      setSession(b)
      assert.equal(scope().id, 'ses_B')
      assert.equal(scope().client, 'clientB')
      assert.notEqual(scope().key, firstKey)
      setSession({ ...b, pending: true })
      assert.equal(scope(), undefined)
      dispose()
    })
  `
  const result = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
