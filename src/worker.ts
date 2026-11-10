// The plugin's worker: owns the reminder list in orca.storage, fires due reminders as desktop
// notifications, keeps the status bar count, and answers the panel and the palette. A save or an
// idle stop drops in-memory state, so everything that matters lives in storage and the timer is
// rebuilt on every start. The status bar item makes Orca start this worker as soon as the plugin
// is enabled and keep it running, so a reminder that came due while Orca was closed fires at launch.
import type { OrcaWorkerApi } from 'orca/worker'
import type { LinkChoice } from './protocol'
import {
  clearDone,
  describeLink,
  fireDue,
  formatDue,
  markDone,
  markWorkspaceRemoved,
  MAX_TEXT,
  MINUTE,
  newId,
  nextDueAt,
  normalize,
  notificationFor,
  parseMorning,
  parseWhen,
  remove,
  reschedule,
  sortReminders,
  statusSummary,
  type Clock,
  type Reminder,
  type ReminderLink
} from './schedule'

const KEY = 'reminders'
const STATUS_ITEM = 'count'
/** How many reminders the "Show pending" notification lists before "and N more". */
const SHOW_LIMIT = 8

/** Exported so tests can shorten the waits. */
export const timing = {
  /**
   * The longest the timer sleeps. Orca stops an idle worker after 5 minutes without host traffic;
   * a check once a minute keeps it alive while reminders are pending and bounds how late one fires.
   */
  heartbeatMs: MINUTE,
  /** How soon to try again after a check failed (storage not ready, say). */
  retryMs: 5_000
}

let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

type WorkspaceRow = { id: string; name: string; path: string; branch: string | null }

export default function activate(orca: OrcaWorkerApi): void {
  stopped = false
  // One write at a time, so a firing tick and a panel edit never overwrite each other.
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  async function load(): Promise<Reminder[]> {
    return normalize(await orca.storage.get(KEY))
  }

  async function save(list: Reminder[]): Promise<Reminder[]> {
    // JSON round trip: storage refuses `undefined` fields (an unset link, a cleared firedAt).
    const sorted = JSON.parse(JSON.stringify(sortReminders(list))) as Reminder[]
    await orca.storage.set(KEY, sorted)
    orca.panels.post('reminders.changed', { reminders: sorted })
    schedule(sorted)
    void showStatus(sorted)
    return sorted
  }

  function arm(wait: number): void {
    if (stopped) return
    clearTimeout(timer)
    timer = setTimeout(() => void tick(), Math.max(0, wait))
  }

  function schedule(list: readonly Reminder[]): void {
    if (stopped) return
    const next = nextDueAt(list)
    if (next === null) {
      clearTimeout(timer)
      timer = undefined
      return
    }
    arm(Math.min(next - Date.now(), timing.heartbeatMs))
  }

  // Settings ---------------------------------------------------------------------------------

  async function setting(key: string): Promise<unknown> {
    try {
      return await orca.settings.get(key)
    } catch {
      return undefined
    }
  }

  async function morning(): Promise<Clock> {
    return parseMorning(await setting('morningTime'))
  }

  // Status bar -------------------------------------------------------------------------------

  let lastStatus = ''
  async function showStatus(list: readonly Reminder[]): Promise<void> {
    if (!orca.host.has('statusBar.update')) return
    const enabled = (await setting('statusBar')) !== false
    const summary = enabled ? statusSummary(list) : ({ visible: false } as const)
    const key = JSON.stringify(summary)
    if (key === lastStatus) return
    lastStatus = key
    try {
      await orca.host.call('statusBar.update', { id: STATUS_ITEM, ...summary })
    } catch (error) {
      lastStatus = ''
      orca.log(`status bar update failed: ${(error as Error).message}`)
    }
  }

  // Firing -----------------------------------------------------------------------------------

  async function notify(title: string, body: string): Promise<void> {
    try {
      await orca.host.call('notifications.show', { title, body })
    } catch (error) {
      orca.log(`notification failed: ${(error as Error).message}`)
    }
  }

  async function check(): Promise<void> {
    const now = Date.now()
    const { list, fired } = fireDue(await load(), now)
    if (fired.length === 0) {
      schedule(list)
      void showStatus(list)
      return
    }
    await save(list)
    for (const reminder of fired) {
      orca.log(`fired ${reminder.id}`)
      const { title, body } = notificationFor(reminder, now)
      await notify(title, body)
    }
  }

  function tick(): Promise<void> {
    return serial(async () => {
      try {
        await check()
      } catch (error) {
        // A failed read must not end the timer: nothing else would wake it until some event.
        orca.log(`check failed, retrying: ${(error as Error).message}`)
        arm(timing.retryMs)
      }
    })
  }

  // Workspaces -------------------------------------------------------------------------------

  async function listWorkspaces(): Promise<WorkspaceRow[]> {
    try {
      return (await orca.host.call('workspace.list', {})).workspaces
    } catch (error) {
      orca.log(`workspace.list failed: ${(error as Error).message}`)
      return []
    }
  }

  /** The listed workspace a name and branch describe: same name and branch, else a unique name. */
  function findWorkspace(rows: readonly WorkspaceRow[], name: string, branch?: string): WorkspaceRow | undefined {
    const exact = rows.find((row) => row.name === name && (row.branch ?? '') === (branch ?? ''))
    if (exact) return exact
    const named = rows.filter((row) => row.name === name)
    return named.length === 1 ? named[0] : undefined
  }

  async function linkFor(choice: LinkChoice | undefined): Promise<ReminderLink | undefined> {
    if (!choice || choice === 'none') return undefined
    const context = await orca.host.call('workspace.readContext', {})
    if (!context) return undefined
    const link: ReminderLink = { workspace: context.displayName || context.branch }
    if (context.branch) link.branch = context.branch
    const row = findWorkspace(await listWorkspaces(), context.displayName, context.branch)
    if (row) {
      link.workspaceId = row.id
      link.path = row.path
    }
    if (choice.startsWith('tab:')) {
      const id = choice.slice('tab:'.length)
      const tab = context.terminals.find((terminal) => terminal.id === id)
      if (tab) link.tab = { id: tab.id, title: tab.title || 'Untitled tab' }
    }
    return link
  }

  async function openWorkspace(id: string): Promise<{ opened: boolean }> {
    const reminder = (await load()).find((item) => item.id === id)
    const link = reminder?.link
    if (!link) throw invalid('This reminder is not tied to a workspace.')
    if (link.removed) throw invalid(`The workspace "${link.workspace}" was removed.`)
    const rows = await listWorkspaces()
    // Reminders from 0.1.0 have no id yet: find the workspace by name and branch.
    const row = link.workspaceId
      ? rows.find((item) => item.id === link.workspaceId) ??
        rows.find((item) => link.path !== undefined && item.path === link.path)
      : findWorkspace(rows, link.workspace, link.branch)
    if (!row) {
      if (rows.length > 0 && (link.workspaceId || link.path)) {
        await edit((list) =>
          markWorkspaceRemoved(list, { workspaceId: link.workspaceId ?? '', path: link.path ?? '' })
        )
        throw invalid(`The workspace "${link.workspace}" was removed.`)
      }
      throw invalid(`Could not find the workspace "${link.workspace}".`)
    }
    await orca.host.call('workspace.open', { workspaceId: row.id })
    return { opened: true }
  }

  // Edits ------------------------------------------------------------------------------------

  function addReminder(text: string, when: string, link?: LinkChoice): Promise<Reminder> {
    return serial(async () => {
      const trimmed = text.trim().slice(0, MAX_TEXT)
      if (trimmed === '') throw invalid('Say what to be reminded about.')
      const now = Date.now()
      const dueAt = parseWhen(when, now, await morning())
      if (dueAt === null) {
        throw invalid(`Could not read the time "${when}". Try 15m, 2h, 16:00, friday or tomorrow 9:00.`)
      }
      const reminder: Reminder = {
        id: newId(now),
        text: trimmed,
        dueAt,
        createdAt: now,
        status: 'pending',
        link: await linkFor(link)
      }
      await save([...(await load()), reminder])
      return reminder
    })
  }

  function edit(change: (list: Reminder[]) => Reminder[]): Promise<Reminder[]> {
    return serial(async () => save(change(await load())))
  }

  async function rescheduleTo(id: string, when: string): Promise<Reminder[]> {
    const dueAt = parseWhen(when, Date.now(), await morning())
    if (dueAt === null) throw invalid(`Could not read the time "${when}".`)
    return edit((list) => reschedule(list, id, dueAt))
  }

  orca.panels.handle('reminders.list', async () => {
    await tick()
    return sortReminders(await load())
  })
  orca.panels.handle('reminders.add', ({ text, when, link }) => addReminder(text, when, link))
  orca.panels.handle('reminders.reschedule', ({ id, when }) => rescheduleTo(id, when))
  orca.panels.handle('reminders.done', ({ id }) => edit((list) => markDone(list, id, Date.now())))
  orca.panels.handle('reminders.cancel', ({ id }) => edit((list) => remove(list, id)))
  orca.panels.handle('reminders.clearDone', () => edit(clearDone))
  orca.panels.handle('reminders.open', ({ id }) => openWorkspace(id))

  // Palette commands. Orca's palette drops a command's return value, so each one also answers
  // with a notification; the string is what Settings → Plugins shows when run from there.
  async function quick(when: string): Promise<string> {
    const context = await orca.host.call('workspace.readContext', {})
    const name = context?.displayName || context?.branch || 'this workspace'
    const reminder = await addReminder(`Check back on ${name}`, when, 'workspace')
    const answer = `Reminder set for ${formatDue(reminder.dueAt, Date.now())}`
    await notify(answer, reminder.text)
    return `${answer}: ${reminder.text}`
  }

  async function due(): Promise<Reminder[]> {
    return (await load()).filter((reminder) => reminder.status === 'due')
  }

  orca.commands.register('remind.15m', () => quick('15m'))
  orca.commands.register('remind.1h', () => quick('1h'))
  orca.commands.register('remind.tomorrow', () => quick('tomorrow'))

  orca.commands.register('reminders.show', async () => {
    const open = sortReminders((await load()).filter((reminder) => reminder.status !== 'done'))
    if (open.length === 0) {
      await notify('No pending reminders', 'Add one from the Reminders panel or the palette.')
      return 'No pending reminders.'
    }
    const now = Date.now()
    const lines = open.map((reminder) => {
      const when = reminder.status === 'due' ? 'DUE' : formatDue(reminder.dueAt, now)
      const where = describeLink(reminder.link)
      return `${when} · ${reminder.text}${where ? ` (${where})` : ''}`
    })
    const dueCount = open.filter((reminder) => reminder.status === 'due').length
    const title =
      dueCount > 0
        ? `${dueCount} due, ${open.length - dueCount} pending`
        : `${open.length} pending reminder${open.length === 1 ? '' : 's'}`
    const shown = lines.slice(0, SHOW_LIMIT)
    if (lines.length > SHOW_LIMIT) shown.push(`and ${lines.length - SHOW_LIMIT} more`)
    await notify(title, shown.join('\n'))
    return lines.join('\n')
  })

  orca.commands.register('reminders.snoozeDue', async () => {
    const ids = (await due()).map((reminder) => reminder.id)
    if (ids.length === 0) return 'Nothing is due.'
    const dueAt = Date.now() + 15 * MINUTE
    await edit((list) => ids.reduce((next, id) => reschedule(next, id, dueAt), list))
    return `Snoozed ${ids.length} until ${formatDue(dueAt, Date.now())}.`
  })

  orca.commands.register('reminders.doneDue', async () => {
    const ids = (await due()).map((reminder) => reminder.id)
    if (ids.length === 0) return 'Nothing is due.'
    const now = Date.now()
    await edit((list) => ids.reduce((next, id) => markDone(next, id, now), list))
    return `Marked ${ids.length} done.`
  })

  orca.commands.register('reminders.openDue', async () => {
    const [first] = sortReminders((await due()).filter((reminder) => reminder.link && !reminder.link.removed))
    if (!first) {
      await notify('No due reminder has a workspace', 'Reminders tied to a workspace can open it.')
      return 'No due reminder has a workspace to open.'
    }
    try {
      await openWorkspace(first.id)
    } catch (error) {
      await notify('Could not open the workspace', (error as Error).message)
      throw error
    }
    return `Opened ${first.link!.workspace}.`
  })

  // Any workspace or agent change wakes the worker too, as a backstop to the status bar start.
  orca.events.on('agent.status.changed', () => tick())
  orca.events.on('workspace.changed', () => tick())
  orca.events.on('workspace.removed', ({ workspaceId, path }) =>
    edit((list) => markWorkspaceRemoved(list, { workspaceId, path })).then(() => undefined)
  )
  orca.settings.onDidChange(() => {
    void load().then((list) => showStatus(list), () => undefined)
  })

  void tick()
}

export function deactivate(): void {
  stopped = true
  clearTimeout(timer)
  timer = undefined
}
