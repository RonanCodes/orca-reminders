// The Reminders sidebar panel. The worker owns the list; this panel shows it and sends edits.
// Everything is Orca's own components, so it follows the person's theme, light or dark.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  host,
  IconButton,
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
  settings,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { LinkChoice } from './protocol'
import { describeLink, formatDue, parseMorning, presets, type Clock, type Reminder } from './schedule'

type Tab = { id: string; title?: string }
type Workspace = { displayName: string; branch: string; terminals: Tab[] } | null
type AgentRow = {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: 'working' | 'blocked' | 'waiting' | 'done'
  stateStartedAt: number
}

/** The most tabs offered under "Link to"; a Select takes at most 500 options. */
const TAB_OPTIONS_MAX = 50

const reminders = atom<Reminder[] | null>(null)
const workspace = atom<Workspace>(null)
const agents = atom<AgentRow[]>([])
const error = atom<string | null>(null)
const morning = atom<Clock>(parseMorning(undefined))

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

async function run(task: () => Promise<unknown>): Promise<boolean> {
  set(error, null)
  try {
    const result = await task()
    if (Array.isArray(result)) set(reminders, result as Reminder[])
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

const done = (id: string) => run(() => plugin.request('reminders.done', { id }))
const cancel = (id: string) => run(() => plugin.request('reminders.cancel', { id }))
const openWorkspace = (id: string) => run(() => plugin.request('reminders.open', { id }))

function toggleMove(id: string): void {
  set(moveTime, '')
  set(moving, read(moving) === id ? null : id)
}

async function loadAgents(): Promise<void> {
  try {
    const answer = await host.call('agents.list', {})
    set(agents, answer.agents)
  } catch {
    set(agents, [])
  }
}

async function loadMorning(): Promise<void> {
  try {
    set(morning, parseMorning(await settings.get('morningTime')))
  } catch {
    // Settings unreadable: keep 09:00 in the labels; the worker decides the real time anyway.
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('reminders.changed', ({ reminders: list }) => set(reminders, list)),
    settings.onDidChange(() => void loadMorning()),
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
  void loadMorning()
}

function linkOptions(ws: Workspace): { value: string; label: string }[] {
  const options = [{ value: 'none', label: 'Nothing' }]
  if (!ws) return options
  options.push({ value: 'workspace', label: `Workspace: ${ws.displayName || ws.branch}` })
  for (const tab of ws.terminals.slice(0, TAB_OPTIONS_MAX)) {
    options.push({ value: `tab:${tab.id}`, label: `Tab: ${tab.title || tab.id}` })
  }
  return options
}

/** The saved link choice, or 'none' when it no longer exists (another workspace, a closed tab). */
function effectiveLink(ws: Workspace): string {
  const choice = read(draftLink)
  return linkOptions(ws).some((option) => option.value === choice) ? choice : 'none'
}

/** Can this reminder's workspace be opened? Not when it has none or Orca removed it. */
function canOpen(reminder: Reminder): boolean {
  return reminder.link !== undefined && reminder.link.removed !== true
}

/** "api › Claude", or "api (removed)" once the workspace is gone. */
function where(reminder: Reminder): string | undefined {
  const text = describeLink(reminder.link)
  return text && reminder.link?.removed ? `${text} (workspace removed)` : text
}

function DueCard({ reminder }: { reminder: Reminder }) {
  const place = where(reminder)
  return (
    <Callout tone="warning" icon="bell" title={reminder.text}>
      <Stack gap="sm">
        <Text size="xs" muted>
          Due <RelativeTime at={reminder.dueAt} />
          {place ? ` · ${place}` : ''}
        </Text>
        <Row gap="xs" wrap>
          <Button size="xs" tone="success" icon="check" onPress={() => done(reminder.id)}>
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
          {canOpen(reminder) ? (
            <Button
              size="xs"
              variant="ghost"
              icon="open-external"
              tooltip="Show this workspace in Orca"
              onPress={() => openWorkspace(reminder.id)}
            >
              Open
            </Button>
          ) : null}
        </Row>
      </Stack>
    </Callout>
  )
}

function MoveForm({ reminder }: { reminder: Reminder }) {
  return (
    <Row gap="xs" align="end">
      <Input
        label="New time"
        placeholder="16:00, 45m, friday 10:00"
        value={read(moveTime)}
        onChange={(value) => set(moveTime, value)}
        onSubmit={(value) => reschedule(reminder.id, value)}
      />
      <Button size="sm" onPress={() => reschedule(reminder.id, read(moveTime))} disabled={read(moveTime).trim() === ''}>
        Save
      </Button>
    </Row>
  )
}

function PendingItem({ reminder, now }: { reminder: Reminder; now: number }) {
  const place = where(reminder)
  const isMoving = read(moving) === reminder.id
  return (
    <Box border radius="md" padding="sm" gap="xs">
      <Row justify="between" align="start" gap="xs">
        <Stack gap="none">
          <Text weight="medium">{reminder.text}</Text>
          <Text size="xs" muted>
            {formatDue(reminder.dueAt, now)} · <RelativeTime at={reminder.dueAt} />
          </Text>
          {place ? (
            <Text size="xs" muted truncate>
              {place}
            </Text>
          ) : null}
        </Stack>
        <Row gap="none">
          <IconButton size="xs" variant="ghost" icon="check" label="Done" onPress={() => done(reminder.id)} />
          <IconButton size="xs" variant="ghost" tone="danger" icon="delete" label="Cancel reminder" onPress={() => cancel(reminder.id)} />
        </Row>
      </Row>
      <Row gap="xs" wrap>
        <Button size="xs" variant="ghost" onPress={() => reschedule(reminder.id, '15m')}>
          +15m
        </Button>
        <Button size="xs" variant="ghost" onPress={() => reschedule(reminder.id, '1h')}>
          +1h
        </Button>
        <Button size="xs" variant="ghost" icon="edit" onPress={() => toggleMove(reminder.id)}>
          {isMoving ? 'Close' : 'Move'}
        </Button>
        {canOpen(reminder) ? (
          <Button size="xs" variant="ghost" icon="open-external" tooltip="Show this workspace in Orca" onPress={() => openWorkspace(reminder.id)}>
            Open
          </Button>
        ) : null}
      </Row>
      {isMoving ? <MoveForm reminder={reminder} /> : null}
    </Box>
  )
}

function AddForm() {
  const ws = read(workspace)
  const custom = read(draftWhen) === 'custom'
  return (
    <Stack gap="sm">
      <Input
        label="Remind me to"
        placeholder="Check whether the review came back"
        value={read(draftText)}
        maxLength={500}
        onChange={(value) => set(draftText, value)}
        onSubmit={() => add()}
      />
      <Select label="When" value={read(draftWhen)} options={presets(read(morning))} onChange={(value) => set(draftWhen, value)} />
      {custom ? (
        <Input
          label="Time"
          placeholder="16:00, 4pm, 45m, 2d, friday 10:00"
          value={read(draftTime)}
          onChange={(value) => set(draftTime, value)}
          onSubmit={() => add()}
        />
      ) : null}
      <Select label="Link to" value={effectiveLink(ws)} options={linkOptions(ws)} onChange={(value) => set(draftLink, value)} />
      <Button icon="bell" onPress={() => add()} disabled={read(draftText).trim() === '' || (custom && read(draftTime).trim() === '')}>
        Add reminder
      </Button>
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

function DoneSection({ list }: { list: Reminder[] }) {
  if (list.length === 0) return null
  return (
    <Collapsible title={`Done (${list.length})`}>
      <Stack gap="xs">
        <List label="Done reminders">
          {list.map((reminder) => (
            <ListItem key={reminder.id} icon="check" title={reminder.text}>
              {reminder.doneAt ? (
                <Text size="xs" muted>
                  <RelativeTime at={reminder.doneAt} />
                </Text>
              ) : null}
            </ListItem>
          ))}
        </List>
        <Button size="xs" variant="ghost" icon="delete" onPress={() => run(() => plugin.request('reminders.clearDone'))}>
          Clear done
        </Button>
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const list = read(reminders)
  const now = Date.now()
  const due = (list ?? []).filter((reminder) => reminder.status === 'due')
  const pending = (list ?? []).filter((reminder) => reminder.status === 'pending')
  const finished = (list ?? []).filter((reminder) => reminder.status === 'done')
  const message = read(error)

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Reminders</Heading>
        {due.length > 0 ? (
          <Badge tone="warning">{`${due.length} due`}</Badge>
        ) : (
          <Badge>{`${pending.length} pending`}</Badge>
        )}
      </Row>

      {message ? (
        <Callout tone="danger" icon="error" title="That did not work">
          <Stack gap="xs">
            <Text size="xs">{message}</Text>
            <Button size="xs" variant="ghost" onPress={() => set(error, null)}>
              Dismiss
            </Button>
          </Stack>
        </Callout>
      ) : null}

      {due.map((reminder) => (
        <DueCard key={reminder.id} reminder={reminder} />
      ))}

      <AddForm />

      {list === null ? (
        <Text muted size="xs">
          Loading…
        </Text>
      ) : pending.length === 0 && due.length === 0 ? (
        <EmptyState
          icon="bell"
          title="Nothing pending"
          description="Add a reminder above, or run “Reminders: Remind me…” from the command palette."
        />
      ) : pending.length > 0 ? (
        <Stack gap="sm">
          <Heading level={3}>{`Pending (${pending.length})`}</Heading>
          {pending.map((reminder) => (
            <PendingItem key={reminder.id} reminder={reminder} now={now} />
          ))}
        </Stack>
      ) : null}

      <AgentsSection />
      <DoneSection list={finished} />
    </Stack>
  )
}
