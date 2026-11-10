// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
// `orca plugin shot . --scenario <name>` draws one of them in Orca, for the README and catalog
// images. Demo names only: nothing here comes from a real workspace.
import type { JsonValue } from 'orca'
import { defineCheck } from 'orca/testing'

const now = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN

const workspace = {
  displayName: 'checkout-redesign',
  branch: 'feat/checkout-redesign',
  terminals: [
    { id: 't1', title: 'Claude: payment form' },
    { id: 't2', title: 'Codex: e2e tests' }
  ]
}

const listed = {
  workspaces: [
    { id: 'w1', kind: 'worktree', name: 'checkout-redesign', path: '/code/shop/checkout-redesign', branch: 'feat/checkout-redesign', hostId: null },
    { id: 'w2', kind: 'worktree', name: 'docs-site', path: '/code/docs-site', branch: 'main', hostId: null }
  ],
  truncated: false
}

const agents = {
  agents: [
    { terminalId: 't1', title: 'Claude: payment form', agent: 'claude', state: 'waiting', stateStartedAt: now - 4 * MIN },
    { terminalId: 't2', title: 'Codex: e2e tests', agent: 'codex', state: 'working', stateStartedAt: now - MIN }
  ]
}

const reminders: { [key: string]: JsonValue }[] = [
  {
    id: 'a',
    text: 'Check whether the design review came back',
    dueAt: now - 2 * MIN,
    createdAt: now - HOUR,
    status: 'pending',
    link: { workspace: 'checkout-redesign', workspaceId: 'w1', tab: { id: 't1', title: 'Claude: payment form' } }
  },
  {
    id: 'b',
    text: 'Re-run CI after the release train',
    dueAt: now + 40 * MIN,
    createdAt: now,
    status: 'pending',
    link: { workspace: 'checkout-redesign', workspaceId: 'w1' }
  },
  {
    id: 'c',
    text: 'Publish the changelog',
    dueAt: now + 3 * HOUR,
    createdAt: now,
    status: 'pending',
    link: { workspace: 'docs-site', workspaceId: 'w2' }
  },
  { id: 'd', text: 'Write the weekly update', dueAt: now + 20 * HOUR, createdAt: now, status: 'pending' },
  { id: 'e', text: 'Merge the docs PR', dueAt: now - 2 * HOUR, createdAt: now, status: 'done', doneAt: now - HOUR }
]

const busy = {
  results: { 'workspace.readContext': workspace, 'workspace.list': listed, 'agents.list': agents },
  storage: { reminders },
  events: [{ event: 'workspace.changed' as const, payload: { context: workspace } }]
}

// The add form set to "At a time…", for the screenshot of typing a time.
const typed = {
  results: busy.results,
  storage: { reminders: reminders.filter((reminder) => reminder.status === 'pending' && reminder.id !== 'a') },
  persisted: { plugin: { 'draft.when': 'custom', 'draft.link': 'tab:t1' } },
  events: busy.events
}

export default defineCheck({
  empty: {},
  busy,
  'busy light': { ...busy, theme: 'light' },
  'busy dark': { ...busy, theme: 'dark' },
  'typed light': { ...typed, theme: 'light' },
  'typed dark': { ...typed, theme: 'dark' },
  'removed workspace': {
    storage: {
      reminders: [
        { id: 'x', text: 'Clean up the spike branch', dueAt: now + HOUR, createdAt: now, status: 'pending', link: { workspace: 'spike', removed: true } }
      ]
    }
  }
})
