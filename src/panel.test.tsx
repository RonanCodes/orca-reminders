import { afterEach, assert, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'
import type { Reminder } from './schedule'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())
const has = (text: string) => JSON.stringify(panel!.tree()).includes(text)

const soon = Date.now() + 30 * 60_000

function fakeWorker(initial: Reminder[] = []) {
  let list = [...initial]
  return {
    get list() {
      return list
    },
    requests: {
      'reminders.list': () => list,
      'reminders.add': ({ text, when, link }: { text: string; when: string; link?: string }) => {
        const r: Reminder = { id: `r${list.length}`, text: `${text} @${when} ${link}`, dueAt: soon, createdAt: 0, status: 'pending' }
        list = [...list, r]
        return r
      },
      'reminders.done': ({ id }: { id: string }) => (list = list.map((r) => (r.id === id ? { ...r, status: 'done' as const, doneAt: 1 } : r))),
      'reminders.reschedule': ({ id }: { id: string }) => (list = list.map((r) => (r.id === id ? { ...r, status: 'pending' as const, dueAt: soon } : r))),
      'reminders.cancel': ({ id }: { id: string }) => (list = list.filter((r) => r.id !== id)),
      'reminders.clearDone': () => (list = list.filter((r) => r.status !== 'done'))
    }
  }
}

test('shows an empty state, then adds a reminder from the form', async () => {
  const worker = fakeWorker()
  panel = await mount(panelModule, { host: mockHost({ requests: worker.requests, results: { 'agents.list': { agents: [] } } }) })
  assert.ok(has('Nothing pending'))
  await panel.type({ label: 'Remind me to' }, 'Check CI')
  await panel.select({ label: 'When' }, '15m')
  await panel.press({ text: 'Add reminder' })
  assert.equal(worker.list.length, 1)
  assert.equal(worker.list[0].text, 'Check CI @15m none')
  assert.equal(panel.valueOf({ label: 'Remind me to' }), '')
  assert.ok(has('Check CI @15m none'))
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.refusals, [])
})

test('custom time and workspace link', async () => {
  const worker = fakeWorker()
  panel = await mount(panelModule, { host: mockHost({ requests: worker.requests, results: { 'agents.list': { agents: [] } } }) })
  await panel.emit('workspace.changed', { context: { displayName: 'api', branch: 'main', terminals: [{ id: 't1', title: 'Claude' }] } })
  await panel.type({ label: 'Remind me to' }, 'Deploy')
  await panel.select({ label: 'When' }, 'custom')
  await panel.type({ label: 'Time' }, '16:00')
  await panel.select({ label: 'Link to' }, 'tab:t1')
  await panel.press({ text: 'Add reminder' })
  assert.equal(worker.list[0].text, 'Deploy @16:00 tab:t1')
})

test('due reminders show with snooze and done', async () => {
  const worker = fakeWorker([{ id: 'd', text: 'Ping Sam', dueAt: Date.now() - 1000, createdAt: 0, status: 'due', link: { workspace: 'api' } }])
  panel = await mount(panelModule, { host: mockHost({ requests: worker.requests, results: { 'agents.list': { agents: [] } } }) })
  assert.ok(has('1 due'))
  assert.ok(has('Ping Sam'))
  await panel.press({ text: 'Snooze 15m' })
  assert.equal(worker.list[0].status, 'pending')
  await panel.post('reminders.changed', { reminders: [{ ...worker.list[0], status: 'due' }] })
  await panel.press({ text: 'Done' })
  assert.equal(worker.list[0].status, 'done')
  assert.ok(has('Done (1)'))
})

test('lists agents that are not working', async () => {
  const worker = fakeWorker()
  const agents = [
    { terminalId: 't1', title: 'Claude: review', agent: 'claude', state: 'waiting', stateStartedAt: Date.now() - 60_000 },
    { terminalId: 't2', title: 'Codex: tests', agent: 'codex', state: 'working', stateStartedAt: Date.now() }
  ]
  panel = await mount(panelModule, { host: mockHost({ requests: worker.requests, results: { 'agents.list': { agents } } }) })
  assert.ok(has('Agents needing you here (1)'))
  assert.ok(has('Claude: review'))
  assert.ok(!has('Codex: tests'))
})

test('opens the workspace of a reminder, and hides Open once it was removed', async () => {
  const opened: string[] = []
  const linked: Reminder = { id: 'a', text: 'Check CI', dueAt: soon, createdAt: 0, status: 'pending', link: { workspace: 'api', workspaceId: 'w1' } }
  const gone: Reminder = { id: 'b', text: 'Old branch', dueAt: soon + 1, createdAt: 0, status: 'pending', link: { workspace: 'spike', removed: true } }
  const worker = fakeWorker([linked, gone])
  panel = await mount(panelModule, {
    host: mockHost({
      requests: { ...worker.requests, 'reminders.open': ({ id }: { id: string }) => (opened.push(id), { opened: true }) },
      results: { 'agents.list': { agents: [] } }
    })
  })
  assert.equal(panel.findAll({ type: 'Button', text: 'Open' }).length, 1)
  await panel.press({ type: 'Button', text: 'Open' })
  assert.deepEqual(opened, ['a'])
  assert.ok(has('spike (workspace removed)'))
})

test('moves a reminder to a typed time', async () => {
  const moved: { id: string; when: string }[] = []
  const worker = fakeWorker([{ id: 'a', text: 'Check CI', dueAt: soon, createdAt: 0, status: 'pending' }])
  panel = await mount(panelModule, {
    host: mockHost({
      requests: { ...worker.requests, 'reminders.reschedule': (input: { id: string; when: string }) => (moved.push(input), worker.list) },
      results: { 'agents.list': { agents: [] } }
    })
  })
  await panel.press({ text: 'Move' })
  await panel.type({ label: 'New time' }, 'friday 10:00', { submit: true })
  assert.deepEqual(moved, [{ id: 'a', when: 'friday 10:00' }])
  assert.equal(panel.find({ label: 'New time' }), null)
})

test('shows a worker error and lets it be dismissed', async () => {
  const worker = fakeWorker()
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        ...worker.requests,
        'reminders.add': () => {
          throw hostError('invalid_params', 'Could not read the time "soonish".')
        }
      },
      results: { 'agents.list': { agents: [] } }
    })
  })
  await panel.type({ label: 'Remind me to' }, 'x')
  await panel.press({ text: 'Add reminder' })
  assert.ok(has('Could not read the time'))
  await panel.press({ text: 'Dismiss' })
  assert.ok(!has('Could not read the time'))
})

test('labels the presets with the morning time setting', async () => {
  const worker = fakeWorker()
  panel = await mount(panelModule, {
    host: mockHost({ requests: worker.requests, settings: { morningTime: '08:30' }, results: { 'agents.list': { agents: [] } } })
  })
  assert.ok(has('Tomorrow 08:30'))
  assert.ok(has('Next Monday 08:30'))
  assert.deepEqual(panel.refusals, [])
})
