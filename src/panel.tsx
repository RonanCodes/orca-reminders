// The Reminders sidebar panel. The worker owns the list; this panel shows it and sends edits.
import {
  atom,
  Badge,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  host,
  Input,
  List,
  ListItem,
  on,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { LinkChoice } from './protocol'
import { describeLink, formatDue, PRESETS, type Reminder } from './schedule'

type Tab = { id: string; title?: string }
type Workspace = { displayName: string; branch: string; terminals: Tab[] } | null
type AgentRow = {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: 'working' | 'blocked' | 'waiting' | 'done'
  stateStartedAt: number
}

const reminders = atom<Reminder[] | null>(null)
const workspace = atom<Workspace>(null)
const agents = atom<AgentRow[]>([])
const error = atom<string | null>(null)

// The form. Keyed atoms survive a hot reload; the chosen preset is remembered across runs.
const draftText = atom('draft.text', '')
const draftWhen = atom('draft.when', '1h', { persist: 'plugin' })
const draftTime = atom('draft.time', '')
const draftLink = atom<string>('draft.link', 'workspace', { persist: 'plugin' })
/** The reminder whose time is being edited, and the text typed for it. */
const moving = atom<string | null>('moving', null)
const moveTime = atom('move.time', '')

function fail(err: unknown): void {
  set(error, (err as Error).message || String(err))
}

async function refresh(): Promise<void> {
  try {
    set(reminders, await plugin.request('reminders.list'))
  } catch (err) {
    fail(err)
  }
}

async function run(task: () => Promise<Reminder[] | Reminder>): Promise<boolean> {
  set(error, null)
  try {
    const result = await task()
    if (Array.isArray(result)) set(reminders, result)
    return true
  } catch (err) {
    fail(err)
    return false
  }
}

async function add(): Promise<void> {
  const when = read(draftWhen) === 'custom' ? read(draftTime) : read(draftWhen)
  const ok = await run(() =>
    plugin.request('reminders.add', {
      text: read(draftText),
      when,
      link: effectiveLink(read(workspace)) as LinkChoice
    })
  )
  if (ok) {
    set(draftText, '')
    set(draftTime, '')
    await refresh()
  }
}

async function reschedule(id: string, when: string): Promise<void> {
  const ok = await run(() => plugin.request('reminders.reschedule', { id, when }))
  if (ok) {
    set(moving, null)
    set(moveTime, '')
  }
}

async function loadAgents(): Promise<void> {
  try {
    const answer = await host.call('agents.list', {})
    set(agents, answer.agents)
  } catch {
    set(agents, [])
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('reminders.changed', ({ reminders: list }) => set(reminders, list)),
    on('workspace.changed', ({ context }) => {
      set(workspace, context)
      void loadAgents()
    }),
    on('agent.status.changed', ({ terminalId, state }) => {
      const rows = read(agents)
      if (!terminalId || !rows.some((row) => row.terminalId === terminalId)) {
        void loadAgents()
        return
      }
      set(
        agents,
        rows.map((row) =>
          row.terminalId === terminalId ? { ...row, state, stateStartedAt: Date.now() } : row
        )
      )
    })
  )
  void refresh()
  void loadAgents()
}

function linkOptions(ws: Workspace): { value: string; label: string }[] {
  const options = [{ value: 'none', label: 'Nothing' }]
  if (!ws) return options
  options.push({ value: 'workspace', label: `Workspace: ${ws.displayName || ws.branch}` })
  for (const tab of ws.terminals.slice(0, 50)) {
    options.push({ value: `tab:${tab.id}`, label: `Tab: ${tab.title || tab.id}` })
  }
  return options
}

/** The saved link choice, or 'none' when it no longer exists (another workspace, a closed tab). */
function effectiveLink(ws: Workspace): string {
  const choice = read(draftLink)
  return linkOptions(ws).some((option) => option.value === choice) ? choice : 'none'
}

function DueCard({ reminder }: { reminder: Reminder }) {
  const where = describeLink(reminder.link)
  return (
    <Callout tone="warning" icon="bell" title={reminder.text}>
      <Stack gap="xs">
        <Text size="xs" muted>
          Due <RelativeTime at={reminder.dueAt} />
          {where ? ` · ${where}` : ''}
        </Text>
        <Row gap="xs" wrap>
          <Button size="xs" tone="success" icon="check" onPress={() => run(() => plugin.request('reminders.done', { id: reminder.id }))}>
            Done
          </Button>
          <Button size="xs" variant="outline" onPress={() => reschedule(reminder.id, '15m')}>
            Snooze 15m
          </Button>
          <Button size="xs" variant="outline" onPress={() => reschedule(reminder.id, '1h')}>
            1h
          </Button>
          <Button size="xs" variant="outline" onPress={() => reschedule(reminder.id, 'tomorrow')}>
            Tomorrow
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function PendingItem({ reminder, now }: { reminder: Reminder; now: number }) {
  const where = describeLink(reminder.link)
  const isMoving = read(moving) === reminder.id
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Stack gap="none">
          <Text weight="medium">{reminder.text}</Text>
          <Text size="xs" muted>
            {formatDue(reminder.dueAt, now)} · <RelativeTime at={reminder.dueAt} />
            {where ? ` · ${where}` : ''}
          </Text>
        </Stack>
      </Row>
      <Row gap="xs" wrap>
        <Button size="xs" variant="ghost" onPress={() => reschedule(reminder.id, '15m')}>
          +15m
        </Button>
        <Button size="xs" variant="ghost" onPress={() => reschedule(reminder.id, '1h')}>
          +1h
        </Button>
        <Button size="xs" variant="ghost" icon="edit" onPress={() => set(moving, isMoving ? null : reminder.id)}>
          Move
        </Button>
        <Button size="xs" variant="ghost" icon="check" onPress={() => run(() => plugin.request('reminders.done', { id: reminder.id }))}>
          Done
        </Button>
        <Button size="xs" variant="ghost" tone="danger" icon="close" onPress={() => run(() => plugin.request('reminders.cancel', { id: reminder.id }))}>
          Cancel
        </Button>
      </Row>
      {isMoving ? (
        <Row gap="xs" align="end">
          <Input
            label="New time"
            placeholder="16:00, 45m, tomorrow 10:00"
            value={read(moveTime)}
            onChange={(value) => set(moveTime, value)}
            onSubmit={(value) => reschedule(reminder.id, value)}
          />
          <Button size="sm" onPress={() => reschedule(reminder.id, read(moveTime))}>
            Save
          </Button>
        </Row>
      ) : null}
    </Stack>
  )
}

function AgentsSection() {
  const rows = read(agents).filter((row) => row.state !== 'working')
  if (rows.length === 0) return null
  const tone = { blocked: 'danger', waiting: 'warning', done: 'success', working: 'accent' } as const
  return (
    <Collapsible title={`Agents needing you here (${rows.length})`} defaultOpen>
      <List label="Agents not working">
        {rows.map((row, index) => (
          <ListItem key={row.terminalId ?? `agent-${index}`} icon="agent" title={row.title || row.agent || 'Agent'}>
            <Row gap="xs">
              <Badge tone={tone[row.state]}>{row.state}</Badge>
              <Text size="xs" muted>
                <RelativeTime at={row.stateStartedAt} format="duration" />
              </Text>
            </Row>
          </ListItem>
        ))}
      </List>
    </Collapsible>
  )
}

export default function Panel() {
  const list = read(reminders)
  const ws = read(workspace)
  const now = Date.now()
  const due = (list ?? []).filter((reminder) => reminder.status === 'due')
  const pending = (list ?? []).filter((reminder) => reminder.status === 'pending')
  const done = (list ?? []).filter((reminder) => reminder.status === 'done')
  const custom = read(draftWhen) === 'custom'
  const message = read(error)

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Reminders</Heading>
        {due.length > 0 ? <Badge tone="warning">{`${due.length} due`}</Badge> : <Badge>{`${pending.length} pending`}</Badge>}
      </Row>

      {message ? (
        <Callout tone="danger" title="That did not work">
          <Text size="xs">{message}</Text>
        </Callout>
      ) : null}

      {due.map((reminder) => (
        <DueCard key={reminder.id} reminder={reminder} />
      ))}

      <Stack gap="sm">
        <Input
          label="Remind me to"
          placeholder="Check whether Sam replied in #builders"
          value={read(draftText)}
          maxLength={500}
          onChange={(value) => set(draftText, value)}
          onSubmit={() => add()}
        />
        <Select
          label="When"
          value={read(draftWhen)}
          options={PRESETS}
          onChange={(value) => set(draftWhen, value)}
        />
        {custom ? (
          <Input
            label="Time"
            placeholder="16:00, 4pm, 45m, 1h30m, tomorrow 10:00"
            value={read(draftTime)}
            onChange={(value) => set(draftTime, value)}
            onSubmit={() => add()}
          />
        ) : null}
        <Select
          label="Link to"
          value={effectiveLink(ws)}
          options={linkOptions(ws)}
          onChange={(value) => set(draftLink, value)}
        />
        <Button icon="bell" onPress={() => add()} disabled={read(draftText).trim() === ''}>
          Add reminder
        </Button>
      </Stack>

      {list === null ? (
        <Text muted size="xs">
          Loading…
        </Text>
      ) : pending.length === 0 && due.length === 0 ? (
        <EmptyState icon="bell" title="Nothing pending" description="Add a reminder above, or run “Reminders: Remind me…” from the palette." />
      ) : pending.length > 0 ? (
        <Stack gap="sm">
          <Text weight="semibold" size="sm">
            Pending
          </Text>
          {pending.map((reminder) => (
            <PendingItem key={reminder.id} reminder={reminder} now={now} />
          ))}
        </Stack>
      ) : null}

      <AgentsSection />

      {done.length > 0 ? (
        <Collapsible title={`Done (${done.length})`}>
          <Stack gap="xs">
            {done.map((reminder) => (
              <Text key={reminder.id} size="xs" muted>
                ✓ {reminder.text}
              </Text>
            ))}
            <Button size="xs" variant="ghost" onPress={() => run(() => plugin.request('reminders.clearDone'))}>
              Clear done
            </Button>
          </Stack>
        </Collapsible>
      ) : null}
    </Stack>
  )
}
