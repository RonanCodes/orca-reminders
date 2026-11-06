// The plugin's worker: owns the reminder list in orca.storage, fires due reminders as desktop
// notifications, and answers the panel. A save or an idle stop drops in-memory state, so
// everything that matters lives in storage and the timer is rebuilt on every start.
import type { OrcaWorkerApi } from 'orca/worker'
import type { LinkChoice } from './protocol'
import {
  clearDone,
  describeLink,
  fireDue,
  formatDue,
  markDone,
  MAX_TEXT,
  MINUTE,
  newId,
  nextDueAt,
  normalize,
  parseWhen,
  remove,
  reschedule,
  sortReminders,
  type Reminder,
  type ReminderLink
} from './schedule'

const KEY = 'reminders'
/**
 * Orca stops a worker after 5 minutes with no host traffic. Checking storage once a minute keeps
 * the scheduler alive while reminders are pending, and bounds how late one can fire.
 */
const HEARTBEAT_MS = MINUTE

let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

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
    return sorted
  }

  function schedule(list: readonly Reminder[]): void {
    if (stopped) return
    clearTimeout(timer)
    const next = nextDueAt(list)
    if (next === null) {
      timer = undefined
      return
    }
    const wait = Math.max(0, Math.min(next - Date.now(), HEARTBEAT_MS))
    timer = setTimeout(() => void tick(), wait)
  }

  async function notify(reminder: Reminder): Promise<void> {
    const where = describeLink(reminder.link)
    try {
      await orca.host.call('notifications.show', {
        title: `⏰ ${reminder.text}`.slice(0, 200),
        body: where ? `Reminder · ${where}` : 'Reminder'
      })
    } catch (error) {
      orca.log(`notification failed: ${(error as Error).message}`)
    }
  }

  function tick(): Promise<void> {
    return serial(async () => {
      const { list, fired } = fireDue(await load(), Date.now())
      if (fired.length === 0) {
        schedule(list)
        return
      }
      await save(list)
      for (const reminder of fired) {
        orca.log(`fired ${reminder.id}`)
        await notify(reminder)
      }
    })
  }

  async function linkFor(choice: LinkChoice | undefined): Promise<ReminderLink | undefined> {
    if (!choice || choice === 'none') return undefined
    const context = await orca.host.call('workspace.readContext', {})
    if (!context) return undefined
    const link: ReminderLink = { workspace: context.displayName || context.branch }
    if (context.branch) link.branch = context.branch
    if (choice.startsWith('tab:')) {
      const id = choice.slice('tab:'.length)
      const tab = context.terminals.find((terminal) => terminal.id === id)
      if (tab) link.tab = { id: tab.id, title: tab.title || 'Untitled tab' }
    }
    return link
  }

  function addReminder(text: string, when: string, link?: LinkChoice): Promise<Reminder> {
    return serial(async () => {
      const trimmed = text.trim().slice(0, MAX_TEXT)
      if (trimmed === '') throw invalid('Say what to be reminded about.')
      const now = Date.now()
      const dueAt = parseWhen(when, now)
      if (dueAt === null) throw invalid(`Could not read the time "${when}". Try 15m, 2h, 16:00 or tomorrow 9:00.`)
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

  orca.panels.handle('reminders.list', async () => {
    await tick()
    return sortReminders(await load())
  })
  orca.panels.handle('reminders.add', ({ text, when, link }) => addReminder(text, when, link))
  orca.panels.handle('reminders.reschedule', ({ id, when }) => {
    const dueAt = parseWhen(when, Date.now())
    if (dueAt === null) throw invalid(`Could not read the time "${when}".`)
    return edit((list) => reschedule(list, id, dueAt))
  })
  orca.panels.handle('reminders.done', ({ id }) => edit((list) => markDone(list, id, Date.now())))
  orca.panels.handle('reminders.cancel', ({ id }) => edit((list) => remove(list, id)))
  orca.panels.handle('reminders.clearDone', () => edit(clearDone))

  // Palette commands: a quick "check back on this workspace" without opening the panel.
  async function quick(when: string): Promise<string> {
    const context = await orca.host.call('workspace.readContext', {})
    const name = context?.displayName || context?.branch || 'this'
    const reminder = await addReminder(`Check back on ${name}`, when, 'workspace')
    return `Reminder set for ${formatDue(reminder.dueAt, Date.now())}: ${reminder.text}`
  }
  orca.commands.register('remind.15m', () => quick('15m'))
  orca.commands.register('remind.1h', () => quick('1h'))
  orca.commands.register('remind.tomorrow', () => quick('tomorrow'))
  orca.commands.register('reminders.show', async () => {
    const open = (await load()).filter((reminder) => reminder.status !== 'done')
    if (open.length === 0) return 'No pending reminders.'
    const now = Date.now()
    return sortReminders(open)
      .map((reminder) => {
        const when = reminder.status === 'due' ? 'DUE' : formatDue(reminder.dueAt, now)
        const where = describeLink(reminder.link)
        return `${when} · ${reminder.text}${where ? ` (${where})` : ''}`
      })
      .join('\n')
  })

  // Any workspace or agent change starts the worker after an Orca restart, so reminders that came
  // due while Orca was closed fire as soon as anything happens, even with the panel closed.
  orca.events.on('agent.status.changed', () => tick())
  orca.events.on('workspace.changed', () => tick())

  void tick()
}

export function deactivate(): void {
  stopped = true
  clearTimeout(timer)
  timer = undefined
}
