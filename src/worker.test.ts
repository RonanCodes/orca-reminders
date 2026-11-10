import { afterEach, assert, hostError, mockHost, mountWorker, test, type MountWorkerOptions, type TestWorker } from 'orca/testing'
import * as main from './worker'

// A failed assertion skips a test's own deactivate; this stops the worker's timer either way.
let current: TestWorker | undefined
afterEach(async () => {
  await current?.deactivate()
  current = undefined
})
async function start(options?: MountWorkerOptions): Promise<TestWorker> {
  current = await mountWorker(main, options)
  return current
}

const context = {
  displayName: 'orca-reminders',
  branch: 'main',
  terminals: [{ id: 't1', title: 'Claude: build plugin' }]
}

test('adds a reminder linked to a tab and lists it', async () => {
  const host = mockHost({ results: { 'workspace.readContext': context } })
  const worker = await start({ host })
  const added = await worker.request('reminders.add', { text: 'Check CI', when: '1h', link: 'tab:t1' })
  assert.equal(added.status, 'pending')
  assert.deepEqual(added.link, {
    workspace: 'orca-reminders',
    branch: 'main',
    tab: { id: 't1', title: 'Claude: build plugin' }
  })
  const list = await worker.request('reminders.list')
  assert.equal(list.length, 1)
  assert.equal(worker.posts.at(-1)?.event, 'reminders.changed')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('fires a due reminder as a notification once', async () => {
  const past = Date.now() - 1000
  const host = mockHost({
    storage: {
      reminders: [{ id: 'r1', text: 'Ping Sam', dueAt: past, createdAt: 0, status: 'pending', link: { workspace: 'api' } }]
    }
  })
  const worker = await start({ host })
  const list = await worker.request('reminders.list')
  assert.equal(list[0].status, 'due')
  await worker.request('reminders.list')
  const shown = host.callsOf('notifications.show')
  assert.equal(shown.length, 1)
  assert.deepEqual(shown[0], { title: '⏰ Ping Sam', body: 'Reminder · api' })
  await worker.deactivate()
})

test('an agent event wakes the worker and fires what is due', async () => {
  const host = mockHost({
    storage: { reminders: [{ id: 'r1', text: 'Wake', dueAt: Date.now() + 50, createdAt: 0, status: 'pending' }] }
  })
  const worker = await start({ host })
  await new Promise((resolve) => setTimeout(resolve, 80))
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', state: 'done', receivedAt: Date.now() })
  assert.equal(host.callsOf('notifications.show').length, 1)
  await worker.deactivate()
})

test('snooze, done, cancel and clear', async () => {
  const host = mockHost({ results: { 'workspace.readContext': null } })
  const worker = await start({ host })
  const a = await worker.request('reminders.add', { text: 'A', when: '15m' })
  const b = await worker.request('reminders.add', { text: 'B', when: '16:00', link: 'workspace' })
  assert.equal(b.link, undefined)
  let list = await worker.request('reminders.reschedule', { id: a.id, when: '2h' })
  assert.ok(list.find((x) => x.id === a.id)!.dueAt > Date.now() + 100 * 60_000)
  list = await worker.request('reminders.done', { id: a.id })
  assert.equal(list.find((x) => x.id === a.id)!.status, 'done')
  list = await worker.request('reminders.cancel', { id: b.id })
  assert.equal(list.length, 1)
  list = await worker.request('reminders.clearDone')
  assert.deepEqual(list, [])
  await worker.deactivate()
})

test('refuses empty text and unreadable times', async () => {
  const worker = await start()
  await assert.rejects(worker.request('reminders.add', { text: '  ', when: '1h' }), /what to be reminded/)
  await assert.rejects(worker.request('reminders.add', { text: 'x', when: 'soonish' }), /Could not read/)
  await worker.deactivate()
})

test('palette commands set and show reminders', async () => {
  const host = mockHost({ results: { 'workspace.readContext': context } })
  const worker = await start({ host })
  const answer = await worker.command('remind.15m')
  assert.match(String(answer), /^Reminder set for \d\d:\d\d: Check back on orca-reminders$/)
  const shown = await worker.command('reminders.show')
  assert.match(String(shown), /Check back on orca-reminders \(orca-reminders\)/)
  await worker.deactivate()
})

// Bug: Orca caps a notification title at 120 characters, and the worker sliced at 200, so a long
// reminder failed validation and never notified.
test('a long reminder still notifies, with its title cut to fit', async () => {
  const text = 'x'.repeat(300)
  const host = mockHost({
    storage: { reminders: [{ id: 'r1', text, dueAt: Date.now() - 1000, createdAt: 0, status: 'pending' }] }
  })
  const worker = await start({ host })
  await worker.request('reminders.list')
  const [shown] = host.callsOf('notifications.show') as { title: string; body: string }[]
  assert.ok(shown, 'notification sent')
  assert.ok(shown.title.length <= 120, `title is ${shown.title.length} long`)
  assert.ok(shown.title.endsWith('…'))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

// Bug: Orca's command palette drops a command's return value, so "Show pending reminders"
// showed nothing. It now answers with a notification too.
test('show pending reminders answers with a notification', async () => {
  const host = mockHost({
    storage: {
      reminders: [
        { id: 'a', text: 'Ping Sam', dueAt: Date.now() + 3_600_000, createdAt: 0, status: 'pending', link: { workspace: 'api' } },
        { id: 'b', text: 'Merge docs', dueAt: Date.now() + 7_200_000, createdAt: 0, status: 'pending' }
      ]
    }
  })
  const worker = await start({ host })
  await worker.command('reminders.show')
  const [shown] = host.callsOf('notifications.show') as { title: string; body: string }[]
  assert.equal(shown.title, '2 pending reminders')
  assert.match(shown.body, /Ping Sam \(api\)/)
  assert.match(shown.body, /Merge docs/)
  await worker.deactivate()
})

// Bug: when a storage read failed inside the timer, the rejection was dropped and no timer was
// set again, so nothing fired until some event woke the worker.
test('a failed storage read does not stop the timer', async () => {
  main.timing.retryMs = 20
  let failNext = true
  let stored: unknown = [{ id: 'r1', text: 'Retry', dueAt: Date.now() + 30, createdAt: 0, status: 'pending' }]
  const host = mockHost({
    results: {
      'storage.get': () => {
        if (failNext) {
          failNext = false
          throw hostError('unavailable', 'storage is not ready')
        }
        return { value: stored }
      },
      'storage.set': ({ value }: { value: unknown }) => {
        stored = value
        return { ok: true }
      }
    }
  })
  const worker = await start({ host })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(host.callsOf('notifications.show').length, 1)
  await worker.deactivate()
  main.timing.retryMs = 5_000
})

test('a reminder that came due while Orca was closed says when it was due', async () => {
  const host = mockHost({
    storage: { reminders: [{ id: 'r1', text: 'Stand-up notes', dueAt: Date.now() - 3 * 3_600_000, createdAt: 0, status: 'pending' }] }
  })
  const worker = await start({ host })
  await worker.request('reminders.list')
  const [shown] = host.callsOf('notifications.show') as { title: string; body: string }[]
  assert.match(shown.body, /was due \d\d:\d\d/)
  await worker.deactivate()
})

test('links the workspace by id, opens it, and marks it when the workspace is removed', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': context,
      'workspace.list': {
        workspaces: [
          { id: 'w-other', kind: 'worktree', name: 'other', path: '/repo/other', branch: 'main', hostId: null },
          { id: 'w-1', kind: 'worktree', name: 'orca-reminders', path: '/repo/orca-reminders', branch: 'main', hostId: null }
        ],
        truncated: false
      },
      'workspace.open': { opened: true }
    }
  })
  const worker = await start({ host })
  const added = await worker.request('reminders.add', { text: 'Check CI', when: '1h', link: 'workspace' })
  assert.equal(added.link?.workspaceId, 'w-1')
  await worker.request('reminders.open', { id: added.id })
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'w-1' }])
  await worker.emit('workspace.removed', { workspaceId: 'w-1', kind: 'worktree', path: '/repo/orca-reminders' })
  const [after] = await worker.request('reminders.list')
  assert.equal(after.link?.removed, true)
  await assert.rejects(worker.request('reminders.open', { id: added.id }), /removed/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the status bar shows due first, and hides when the setting is off', async () => {
  const host = mockHost({
    storage: {
      reminders: [
        { id: 'a', text: 'A', dueAt: Date.now() - 1000, createdAt: 0, status: 'pending' },
        { id: 'b', text: 'B', dueAt: Date.now() + 3_600_000, createdAt: 0, status: 'pending' }
      ]
    }
  })
  const worker = await start({ host })
  await worker.request('reminders.list')
  const updates = host.callsOf('statusBar.update') as Record<string, unknown>[]
  assert.deepEqual(updates.at(-1), { id: 'count', visible: true, text: '1 due', tone: 'warning', tooltip: 'Reminders: 1 due, 1 pending' })
  await worker.request('reminders.done', { id: 'a' })
  await worker.request('reminders.done', { id: 'b' })
  assert.deepEqual(host.callsOf('statusBar.update').at(-1), { id: 'count', visible: false })
  assert.deepEqual(worker.refusals, [])
})

test('the status bar stays hidden when its setting is off', async () => {
  const host = mockHost({
    settings: { statusBar: false },
    storage: { reminders: [{ id: 'a', text: 'A', dueAt: Date.now() + 60_000, createdAt: 0, status: 'pending' }] }
  })
  const worker = await start({ host })
  await worker.request('reminders.list')
  assert.deepEqual(host.callsOf('statusBar.update'), [{ id: 'count', visible: false }])
})

test('tomorrow follows the morning time setting', async () => {
  const host = mockHost({ settings: { morningTime: '07:30' } })
  const worker = await start({ host })
  const added = await worker.request('reminders.add', { text: 'Early', when: 'tomorrow' })
  const due = new Date(added.dueAt)
  assert.equal(`${due.getHours()}:${due.getMinutes()}`, '7:30')
})

test('palette: snooze, finish and open due reminders', async () => {
  const past = Date.now() - 60_000
  const host = mockHost({
    storage: {
      reminders: [
        { id: 'a', text: 'A', dueAt: past, createdAt: 0, status: 'due', link: { workspace: 'api', branch: 'main' } },
        { id: 'b', text: 'B', dueAt: past, createdAt: 0, status: 'due' }
      ]
    },
    results: {
      'workspace.list': { workspaces: [{ id: 'w-api', kind: 'worktree', name: 'api', path: '/r/api', branch: 'main', hostId: null }], truncated: false },
      'workspace.open': { opened: true }
    }
  })
  const worker = await start({ host })
  // An old (0.1.0) reminder has no workspace id: it is found by name and branch.
  assert.equal(await worker.command('reminders.openDue'), 'Opened api.')
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'w-api' }])
  assert.match(String(await worker.command('reminders.snoozeDue')), /^Snoozed 2 until/)
  assert.equal(await worker.command('reminders.doneDue'), 'Nothing is due.')
  const list = await worker.request('reminders.list')
  assert.deepEqual(list.map((r) => r.status), ['pending', 'pending'])
})

test('quick commands confirm with a notification', async () => {
  const host = mockHost({ results: { 'workspace.readContext': context } })
  const worker = await start({ host })
  await worker.command('remind.1h')
  const [shown] = host.callsOf('notifications.show') as { title: string; body: string }[]
  assert.match(shown.title, /^Reminder set for \d\d:\d\d$/)
  assert.equal(shown.body, 'Check back on orca-reminders')
})

test('opening a reminder without a workspace explains why', async () => {
  const worker = await start()
  const added = await worker.request('reminders.add', { text: 'Loose', when: '1h' })
  await assert.rejects(worker.request('reminders.open', { id: added.id }), /not tied to a workspace/)
})

test('open marks a workspace removed only when Orca listed every workspace', async () => {
  const stored = [{ id: 'a', text: 'A', dueAt: Date.now() + 60_000, createdAt: 0, status: 'pending', link: { workspace: 'gone', workspaceId: 'w9', path: '/r/gone' } }]
  const other = { id: 'w1', kind: 'worktree', name: 'other', path: '/r/other', branch: 'main', hostId: null }
  const cut = mockHost({ storage: { reminders: stored }, results: { 'workspace.list': { workspaces: [other], truncated: true } } })
  let worker = await start({ host: cut })
  await assert.rejects(worker.request('reminders.open', { id: 'a' }), /Could not find/)
  assert.equal((await worker.request('reminders.list'))[0].link?.removed, undefined)
  await worker.deactivate()

  const full = mockHost({ storage: { reminders: stored }, results: { 'workspace.list': { workspaces: [other], truncated: false } } })
  worker = await start({ host: full })
  await assert.rejects(worker.request('reminders.open', { id: 'a' }), /was removed/)
  assert.equal((await worker.request('reminders.list'))[0].link?.removed, true)
})
