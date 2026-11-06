// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
import { defineCheck } from 'orca/testing'

const now = Date.now()

export default defineCheck({
  empty: {},
  busy: {
    results: {
      'workspace.readContext': { displayName: 'orca-reminders', branch: 'main', terminals: [{ id: 't1', title: 'Claude' }] },
      'agents.list': {
        agents: [{ terminalId: 't1', title: 'Claude: review PR', agent: 'claude', state: 'waiting', stateStartedAt: now - 120_000 }]
      }
    },
    storage: {
      reminders: [
        { id: 'a', text: 'Check whether Sam replied', dueAt: now - 60_000, createdAt: now - 3_600_000, status: 'pending', link: { workspace: 'api', tab: { id: 't1', title: 'Claude' } } },
        { id: 'b', text: 'Check CI after the release train', dueAt: now + 45 * 60_000, createdAt: now, status: 'pending', link: { workspace: 'orca-reminders' } },
        { id: 'c', text: 'Write the weekly update', dueAt: now + 20 * 3_600_000, createdAt: now, status: 'pending' },
        { id: 'd', text: 'Merge the docs PR', dueAt: now - 7_200_000, createdAt: now, status: 'done', doneAt: now - 3_600_000 }
      ]
    }
  }
})
