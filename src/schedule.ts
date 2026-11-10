// Pure reminder logic shared by the worker and the panel: the data shape, parsing "when" text,
// and the list operations. No Orca calls here, so it is easy to test.

export type ReminderLink = {
  /** Display name of the workspace the reminder was set from. */
  workspace: string
  /** Branch of that workspace, when Orca reported one. */
  branch?: string
  /** Orca's id for the workspace (from `workspace.list`), so the reminder can open it. */
  workspaceId?: string
  /** Where the workspace lives on disk; `workspace.removed` names a workspace by path too. */
  path?: string
  /** Set once Orca reports the workspace removed: the reminder stays, the Open button goes. */
  removed?: boolean
  /** A terminal or chat tab in that workspace, when one was picked. */
  tab?: { id: string; title: string }
}

export type ReminderStatus = 'pending' | 'due' | 'done'

export type Reminder = {
  id: string
  text: string
  /** Epoch ms when it should fire. */
  dueAt: number
  createdAt: number
  status: ReminderStatus
  /** Epoch ms when the notification went out. */
  firedAt?: number
  /** Epoch ms when it was marked done. */
  doneAt?: number
  link?: ReminderLink
}

export type Clock = { hours: number; minutes: number }

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
/** How many done reminders to keep for the "Done" list. */
export const DONE_KEPT = 20
export const MAX_TEXT = 500
/** Orca refuses a notification title longer than this. */
export const NOTIFICATION_TITLE_MAX = 120
/** A reminder that fires this long after its time says when it was due (Orca was closed). */
const LATE_AFTER = 2 * MINUTE

/** What "tomorrow" and "next week" mean when no time is given, unless the setting says otherwise. */
export const DEFAULT_MORNING: Clock = { hours: 9, minutes: 0 }
/** The choices the "Morning time" setting offers (see orca-plugin.json). */
export const MORNING_CHOICES = ['07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00'] as const

export function formatClock(clock: Clock): string {
  return `${String(clock.hours).padStart(2, '0')}:${String(clock.minutes).padStart(2, '0')}`
}

/** The quick choices offered in the panel's When picker, labelled with the morning time. */
export function presets(morning: Clock = DEFAULT_MORNING): { value: string; label: string }[] {
  const at = formatClock(morning)
  return [
    { value: '15m', label: 'In 15 minutes' },
    { value: '1h', label: 'In 1 hour' },
    { value: '3h', label: 'In 3 hours' },
    { value: 'tomorrow', label: `Tomorrow ${at}` },
    { value: 'next week', label: `Next Monday ${at}` },
    { value: 'custom', label: 'At a time…' }
  ]
}

/** Reads the "Morning time" setting; anything unexpected falls back to 09:00. */
export function parseMorning(value: unknown): Clock {
  if (typeof value !== 'string') return DEFAULT_MORNING
  return parseClock(value.trim().toLowerCase()) ?? DEFAULT_MORNING
}

/** A wall-clock time `dayOffset` calendar days from `now`. Calendar days keep the clock time
 *  across a daylight saving change, where adding 24 hours would not. */
function atClock(now: number, hours: number, minutes: number, dayOffset: number): number {
  const date = new Date(now)
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hours, minutes, 0, 0)
  return date.getTime()
}

function parseClock(text: string): Clock | null {
  // 16:00, 9:30, 9.30, 16, 4pm, 4:30pm
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(text)
  if (!match) return null
  let hours = Number(match[1])
  const minutes = match[2] === undefined ? 0 : Number(match[2])
  const meridiem = match[3]
  if (meridiem) {
    if (hours < 1 || hours > 12) return null
    if (meridiem === 'pm' && hours !== 12) hours += 12
    if (meridiem === 'am' && hours === 12) hours = 0
  }
  if (hours > 23 || minutes > 59) return null
  return { hours, minutes }
}

/** "", "10:30" or "at 4pm" after a day word: the time, the morning when empty, null when unreadable. */
function clockAfterDay(rest: string, morning: Clock): Clock | null {
  const text = rest.trim().replace(/^at\s*/, '')
  return text === '' ? morning : parseClock(text)
}

function parseDuration(text: string): number | null {
  // 15m, 15 min, 1h, 1h30m, 2 hours, 90, in 20m, +20m
  if (/^\d+$/.test(text)) return Number(text) * MINUTE
  const match =
    /^(?:(\d+)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?$/.exec(text)
  if (!match || (match[1] === undefined && match[2] === undefined)) return null
  return Number(match[1] ?? 0) * HOUR + Number(match[2] ?? 0) * MINUTE
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** "mon", "tues", "friday": a weekday's first three or more letters; -1 for anything else. */
function weekdayIndex(word: string): number {
  if (word.length < 3) return -1
  return WEEKDAYS.findIndex((day) => day.startsWith(word))
}

/**
 * Turns "15m", "1h30m", "16:00", "4pm", "tomorrow", "tomorrow 10:30", "2d", "friday 14:00",
 * "next week" or a preset value into an epoch ms after `now`. A clock time that already passed
 * today means tomorrow; a weekday that already passed this week means next week. Null when the
 * text is not understood. `morning` is the time used when a day is given without one.
 */
export function parseWhen(input: string, now: number, morning: Clock = DEFAULT_MORNING): number | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(in|\+)\s*/, '')
  if (text === '') return null

  if (text.startsWith('tomorrow')) {
    const clock = clockAfterDay(text.slice('tomorrow'.length), morning)
    return clock ? atClock(now, clock.hours, clock.minutes, 1) : null
  }

  if (text === 'next week') return nextWeekday(now, 1, morning, true)

  const days = /^(\d+)\s*(?:d|day|days)$/.exec(text)
  if (days) {
    const count = Number(days[1])
    if (count === 0) return null
    const date = new Date(now)
    return atClock(now, date.getHours(), date.getMinutes(), count)
  }

  const weekday = /^(next\s+)?([a-z]+)\b(.*)$/.exec(text)
  if (weekday) {
    const index = weekdayIndex(weekday[2])
    if (index >= 0) {
      const clock = clockAfterDay(weekday[3], morning)
      return clock ? nextWeekday(now, index, clock, false) : null
    }
  }

  const duration = parseDuration(text)
  if (duration !== null) return duration > 0 ? now + duration : null

  const clock = parseClock(text.replace(/^at\s*/, ''))
  if (!clock) return null
  const today = atClock(now, clock.hours, clock.minutes, 0)
  return today > now ? today : atClock(now, clock.hours, clock.minutes, 1)
}

/** The next `weekday` (0 Sunday) at `clock` after `now`; today counts only when the time is still
 *  ahead, unless `skipToday` is set. */
function nextWeekday(now: number, weekday: number, clock: Clock, skipToday: boolean): number {
  const today = new Date(now).getDay()
  let offset = (weekday - today + 7) % 7
  if (offset === 0 && (skipToday || atClock(now, clock.hours, clock.minutes, 0) <= now)) offset = 7
  return atClock(now, clock.hours, clock.minutes, offset)
}

/** "16:05", or "Tue 09:00" when it is not today. */
export function formatDue(dueAt: number, now: number): string {
  const due = new Date(dueAt)
  const time = formatClock({ hours: due.getHours(), minutes: due.getMinutes() })
  if (due.toDateString() === new Date(now).toDateString()) return time
  const day = due.toLocaleDateString('en-GB', { weekday: 'short' })
  const inAWeek = Math.abs(dueAt - now) < 6 * 24 * HOUR
  return inAWeek
    ? `${day} ${time}`
    : `${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`
}

export function describeLink(link: ReminderLink | undefined): string | undefined {
  if (!link) return undefined
  return link.tab ? `${link.workspace} › ${link.tab.title}` : link.workspace
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** The desktop notification for a reminder that just fired, inside Orca's limits. */
export function notificationFor(reminder: Reminder, now: number): { title: string; body: string } {
  const parts = ['Reminder']
  const where = describeLink(reminder.link)
  if (where) parts.push(where)
  if (now - reminder.dueAt > LATE_AFTER) parts.push(`was due ${formatDue(reminder.dueAt, now)}`)
  return {
    title: cut(`⏰ ${reminder.text}`, NOTIFICATION_TITLE_MAX),
    body: cut(parts.join(' · '), 1000)
  }
}

export type StatusSummary =
  | { visible: false }
  | { visible: true; text: string; tone: 'neutral' | 'warning'; tooltip: string }

/** What the status bar item shows: due reminders first, hidden when nothing is open. */
export function statusSummary(list: readonly Reminder[]): StatusSummary {
  const due = list.filter((reminder) => reminder.status === 'due').length
  const pending = list.filter((reminder) => reminder.status === 'pending').length
  if (due === 0 && pending === 0) return { visible: false }
  if (due === 0) return { visible: true, text: String(pending), tone: 'neutral', tooltip: `Reminders: ${pending} pending` }
  return {
    visible: true,
    text: `${due} due`,
    tone: 'warning',
    tooltip: `Reminders: ${due} due${pending > 0 ? `, ${pending} pending` : ''}`
  }
}

function cleanLink(value: unknown): ReminderLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.workspace !== 'string') return undefined
  const link: ReminderLink = { workspace: raw.workspace }
  if (typeof raw.branch === 'string') link.branch = raw.branch
  if (typeof raw.workspaceId === 'string') link.workspaceId = raw.workspaceId
  if (typeof raw.path === 'string') link.path = raw.path
  if (raw.removed === true) link.removed = true
  const tab = raw.tab as Record<string, unknown> | undefined
  if (tab && typeof tab.id === 'string' && typeof tab.title === 'string') link.tab = { id: tab.id, title: tab.title }
  return link
}

/** Coerces whatever storage holds into a clean list; drops anything malformed. */
export function normalize(value: unknown): Reminder[] {
  if (!Array.isArray(value)) return []
  const list: Reminder[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (
      typeof raw.id !== 'string' ||
      typeof raw.text !== 'string' ||
      typeof raw.dueAt !== 'number' ||
      !['pending', 'due', 'done'].includes(raw.status as string)
    ) {
      continue
    }
    const reminder: Reminder = {
      id: raw.id,
      text: raw.text,
      dueAt: raw.dueAt,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : raw.dueAt,
      status: raw.status as ReminderStatus
    }
    if (typeof raw.firedAt === 'number') reminder.firedAt = raw.firedAt
    if (typeof raw.doneAt === 'number') reminder.doneAt = raw.doneAt
    const link = cleanLink(raw.link)
    if (link) reminder.link = link
    list.push(reminder)
  }
  return list
}

/** Due first (oldest first), then pending by time, then done (newest first). */
export function sortReminders(list: readonly Reminder[]): Reminder[] {
  const rank: Record<ReminderStatus, number> = { due: 0, pending: 1, done: 2 }
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return rank[a.status] - rank[b.status]
    if (a.status === 'done') return (b.doneAt ?? 0) - (a.doneAt ?? 0)
    return a.dueAt - b.dueAt
  })
}

/** Marks every pending reminder whose time has come as due; returns the list and those that fired. */
export function fireDue(
  list: readonly Reminder[],
  now: number
): { list: Reminder[]; fired: Reminder[] } {
  const fired: Reminder[] = []
  const next = list.map((reminder) => {
    if (reminder.status !== 'pending' || reminder.dueAt > now) return reminder
    const due: Reminder = { ...reminder, status: 'due', firedAt: now }
    fired.push(due)
    return due
  })
  return { list: next, fired }
}

/** The next time something pending fires, or null. */
export function nextDueAt(list: readonly Reminder[]): number | null {
  let next: number | null = null
  for (const reminder of list) {
    if (reminder.status === 'pending' && (next === null || reminder.dueAt < next)) {
      next = reminder.dueAt
    }
  }
  return next
}

/** Moves a reminder to a new time and makes it pending again (snooze and move). */
export function reschedule(list: readonly Reminder[], id: string, dueAt: number): Reminder[] {
  return list.map((reminder) =>
    reminder.id === id
      ? { ...reminder, dueAt, status: 'pending', firedAt: undefined, doneAt: undefined }
      : reminder
  )
}

export function markDone(list: readonly Reminder[], id: string, now: number): Reminder[] {
  const next = list.map((reminder) =>
    reminder.id === id ? { ...reminder, status: 'done' as const, doneAt: now } : reminder
  )
  return trimDone(next)
}

/** Marks the reminders linked to a removed workspace, matched by id or by path. */
export function markWorkspaceRemoved(
  list: readonly Reminder[],
  removed: { workspaceId: string; path: string }
): Reminder[] {
  return list.map((reminder) => {
    const link = reminder.link
    if (!link || link.removed) return reminder
    const same = link.workspaceId === removed.workspaceId || (link.path !== undefined && link.path === removed.path)
    return same ? { ...reminder, link: { ...link, removed: true } } : reminder
  })
}

export function remove(list: readonly Reminder[], id: string): Reminder[] {
  return list.filter((reminder) => reminder.id !== id)
}

export function clearDone(list: readonly Reminder[]): Reminder[] {
  return list.filter((reminder) => reminder.status !== 'done')
}

function trimDone(list: Reminder[]): Reminder[] {
  const done = list
    .filter((reminder) => reminder.status === 'done')
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
  const keep = new Set(done.slice(0, DONE_KEPT).map((reminder) => reminder.id))
  return list.filter((reminder) => reminder.status !== 'done' || keep.has(reminder.id))
}

export function newId(now: number): string {
  return `r-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
