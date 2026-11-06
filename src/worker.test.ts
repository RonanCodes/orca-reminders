import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const context = {
  displayName: 'orca-reminders',
  branch: 'main',
  terminals: [{ id: 't1', title: 'Claude: build plugin' }]
}

test('adds a reminder linked to a tab and lists it', async () => {
  const host = mockHost({ results: { 'workspace.readContext': context } })
  const worker = await mountWorker(main, { host })
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
  const worker = await mountWorker(main, { host })
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
  const worker = await mountWorker(main, { host })
  await new Promise((resolve) => setTimeout(resolve, 80))
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', state: 'done', receivedAt: Date.now() })
  assert.equal(host.callsOf('notifications.show').length, 1)
  await worker.deactivate()
})

test('snooze, done, cancel and clear', async () => {
  const host = mockHost({ results: { 'workspace.readContext': null } })
  const worker = await mountWorker(main, { host })
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
  const worker = await mountWorker(main)
  await assert.rejects(worker.request('reminders.add', { text: '  ', when: '1h' }), /what to be reminded/)
  await assert.rejects(worker.request('reminders.add', { text: 'x', when: 'soonish' }), /Could not read/)
  await worker.deactivate()
})

test('palette commands set and show reminders', async () => {
  const host = mockHost({ results: { 'workspace.readContext': context } })
  const worker = await mountWorker(main, { host })
  const answer = await worker.command('remind.15m')
  assert.match(String(answer), /^Reminder set for \d\d:\d\d: Check back on orca-reminders$/)
  const shown = await worker.command('reminders.show')
  assert.match(String(shown), /Check back on orca-reminders \(orca-reminders\)/)
  await worker.deactivate()
})
