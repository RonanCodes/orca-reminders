import { assert, test } from 'orca/testing'
import {
  fireDue,
  HOUR,
  markDone,
  MINUTE,
  nextDueAt,
  normalize,
  notificationFor,
  parseMorning,
  parseWhen,
  reschedule,
  sortReminders,
  statusSummary,
  type Reminder
} from './schedule'

// Thu 5 Nov 2026, 14:30 local time.
const NOW = new Date(2026, 10, 5, 14, 30, 0, 0).getTime()
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m, 0, 0).getTime()

test('parses durations', () => {
  assert.equal(parseWhen('15m', NOW), NOW + 15 * MINUTE)
  assert.equal(parseWhen('1h', NOW), NOW + HOUR)
  assert.equal(parseWhen('1h30m', NOW), NOW + 90 * MINUTE)
  assert.equal(parseWhen('in 2 hours', NOW), NOW + 2 * HOUR)
  assert.equal(parseWhen('+20 min', NOW), NOW + 20 * MINUTE)
  assert.equal(parseWhen('45', NOW), NOW + 45 * MINUTE)
  assert.equal(parseWhen('3h', NOW), NOW + 3 * HOUR)
})

test('parses clock times, rolling to tomorrow when passed', () => {
  assert.equal(parseWhen('16:00', NOW), at(5, 16))
  assert.equal(parseWhen('4pm', NOW), at(5, 16))
  assert.equal(parseWhen('at 4:15pm', NOW), at(5, 16, 15))
  assert.equal(parseWhen('9:00', NOW), at(6, 9))
  assert.equal(parseWhen('14:30', NOW), at(6, 14, 30))
  assert.equal(parseWhen('12am', NOW), at(6, 0))
})

test('parses tomorrow', () => {
  assert.equal(parseWhen('tomorrow', NOW), at(6, 9))
  assert.equal(parseWhen('Tomorrow 10:30', NOW), at(6, 10, 30))
  assert.equal(parseWhen('tomorrow at 7pm', NOW), at(6, 19))
})

test('refuses nonsense', () => {
  for (const text of ['', 'soon', '25:00', '13pm', '0m', 'tomorrow lunch', '9:75']) {
    assert.equal(parseWhen(text, NOW), null, text)
  }
})

const r = (id: string, dueAt: number, status: Reminder['status'] = 'pending'): Reminder => ({
  id,
  text: id,
  dueAt,
  createdAt: 0,
  status
})

test('fires only pending reminders whose time came', () => {
  const list = [r('a', NOW - 1), r('b', NOW + MINUTE), r('c', NOW - 5, 'done'), r('d', NOW - 9, 'due')]
  const { list: next, fired } = fireDue(list, NOW)
  assert.deepEqual(fired.map((x) => x.id), ['a'])
  assert.equal(next[0].status, 'due')
  assert.equal(next[0].firedAt, NOW)
  assert.equal(nextDueAt(next), NOW + MINUTE)
})

test('reschedule makes a due reminder pending again', () => {
  const [moved] = reschedule([{ ...r('a', NOW - 1, 'due'), firedAt: NOW }], 'a', NOW + HOUR)
  assert.equal(moved.status, 'pending')
  assert.equal(moved.dueAt, NOW + HOUR)
  assert.equal(moved.firedAt, undefined)
})

test('sorts due, pending, done and keeps 20 done', () => {
  let list: Reminder[] = []
  for (let i = 0; i < 25; i++) list.push(r(`p${i}`, NOW + i))
  for (let i = 0; i < 25; i++) list = markDone(list, `p${i}`, NOW + i)
  assert.equal(list.length, 20)
  assert.equal(sortReminders(list)[0].id, 'p24')
  const mixed = sortReminders([r('late', NOW + 2), r('x', 0, 'done'), r('due', NOW, 'due'), r('soon', NOW + 1)])
  assert.deepEqual(mixed.map((x) => x.id), ['due', 'soon', 'late', 'x'])
})

test('normalize drops malformed entries', () => {
  assert.deepEqual(normalize(null), [])
  assert.deepEqual(normalize([{ id: 1 }, r('ok', 1), { ...r('bad', 1), status: 'weird' }]).map((x) => x.id), ['ok'])
})

test('parses days, weekdays and next week', () => {
  // NOW is Thursday 5 Nov 2026, 14:30.
  assert.equal(parseWhen('2d', NOW), at(7, 14, 30))
  assert.equal(parseWhen('in 3 days', NOW), at(8, 14, 30))
  assert.equal(parseWhen('monday', NOW), at(9, 9))
  assert.equal(parseWhen('Fri 4pm', NOW), at(6, 16))
  assert.equal(parseWhen('thursday', NOW), at(12, 9))
  assert.equal(parseWhen('thursday 16:00', NOW), at(5, 16))
  assert.equal(parseWhen('next week', NOW), at(9, 9))
  assert.equal(parseWhen('next monday at 10:15', NOW), at(9, 10, 15))
  assert.equal(parseWhen('funday', NOW), null)
})

test('tomorrow and next week use the chosen morning time', () => {
  const morning = parseMorning('07:30')
  assert.equal(parseWhen('tomorrow', NOW, morning), at(6, 7, 30))
  assert.equal(parseWhen('next week', NOW, morning), at(9, 7, 30))
  assert.equal(parseWhen('tomorrow 11:00', NOW, morning), at(6, 11))
  assert.deepEqual(parseMorning('nonsense'), { hours: 9, minutes: 0 })
  assert.deepEqual(parseMorning(undefined), { hours: 9, minutes: 0 })
})

test('keeps wall-clock times across daylight saving changes', () => {
  // Node reads TZ again whenever it changes; orca/testing has no Node typings, hence the cast.
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
  const zone = env.TZ
  env.TZ = 'Europe/Amsterdam'
  try {
    // Saturday 24 Oct 2026, 22:00; clocks go back an hour that night.
    const beforeFallBack = new Date(2026, 9, 24, 22, 0).getTime()
    const tomorrow = new Date(parseWhen('tomorrow', beforeFallBack)!)
    assert.equal(tomorrow.getDate(), 25)
    assert.equal(tomorrow.getHours(), 9)
    // A duration is real time: 12 hours later reads as 09:00 on the Sunday, not 10:00.
    assert.equal(new Date(parseWhen('12h', beforeFallBack)!).getHours(), 9)
    // 2 days keeps the clock time even though one of those days is 25 hours long.
    assert.equal(new Date(parseWhen('2d', beforeFallBack)!).getHours(), 22)
    // Saturday 28 Mar 2026, 10:00; clocks go forward that night.
    const beforeSpring = new Date(2026, 2, 28, 10, 0).getTime()
    const sunday = new Date(parseWhen('tomorrow 10:00', beforeSpring)!)
    assert.equal(sunday.getDate(), 29)
    assert.equal(sunday.getHours(), 10)
    assert.equal(parseWhen('tomorrow 10:00', beforeSpring)! - beforeSpring, 23 * HOUR)
  } finally {
    if (zone === undefined) delete env.TZ
    else env.TZ = zone
  }
})

test('notification text fits Orca limits and says when an old one was due', () => {
  const late = notificationFor({ ...r('a', NOW - 2 * HOUR), text: 'y'.repeat(400), link: { workspace: 'api', tab: { id: 't', title: 'Claude' } } }, NOW)
  assert.ok(late.title.length <= 120)
  assert.match(late.body, /^Reminder · api › Claude · was due 12:30$/)
  const fresh = notificationFor(r('b', NOW - 5000), NOW)
  assert.equal(fresh.title, '⏰ b')
  assert.equal(fresh.body, 'Reminder')
})

test('status bar summary', () => {
  assert.deepEqual(statusSummary([]), { visible: false })
  assert.deepEqual(statusSummary([r('a', NOW + 1)]), { visible: true, text: '1', tone: 'neutral', tooltip: 'Reminders: 1 pending' })
  assert.deepEqual(statusSummary([r('a', NOW, 'due'), r('b', NOW + 1), r('c', 0, 'done')]), {
    visible: true,
    text: '1 due',
    tone: 'warning',
    tooltip: 'Reminders: 1 due, 1 pending'
  })
})

test('normalize keeps a clean link and drops a broken one', () => {
  const [kept, broken] = normalize([
    { ...r('a', 1), link: { workspace: 'api', workspaceId: 'w1', path: '/x', tab: { id: 't', title: 'T' }, extra: 1 } },
    { ...r('b', 1), link: 'api' }
  ])
  assert.deepEqual(kept.link, { workspace: 'api', workspaceId: 'w1', path: '/x', tab: { id: 't', title: 'T' } })
  assert.equal(broken.link, undefined)
})
