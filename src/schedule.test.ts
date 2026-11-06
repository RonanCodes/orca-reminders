import { assert, test } from 'orca/testing'
import {
  fireDue,
  HOUR,
  markDone,
  MINUTE,
  nextDueAt,
  normalize,
  parseWhen,
  reschedule,
  sortReminders,
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
