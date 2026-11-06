// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Reminder } from './schedule'

export type { Reminder }

/** What to tie a new reminder to: nothing, the focused workspace, or one of its tabs by id. */
export type LinkChoice = 'none' | 'workspace' | `tab:${string}`

declare module 'orca' {
  interface PluginRequests {
    /** Every reminder, due first, then pending by time, then recently done. */
    'reminders.list': { output: Reminder[] }
    /** Adds one. `when` is a preset ("15m", "1h", "tomorrow") or free text ("16:00", "45m"). */
    'reminders.add': {
      input: { text: string; when: string; link?: LinkChoice }
      output: Reminder
    }
    /** Moves a reminder to a new time ("15m", "16:00", ...) and makes it pending again. */
    'reminders.reschedule': { input: { id: string; when: string }; output: Reminder[] }
    'reminders.done': { input: { id: string }; output: Reminder[] }
    'reminders.cancel': { input: { id: string }; output: Reminder[] }
    'reminders.clearDone': { output: Reminder[] }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after the list changes, including when one fires. */
    'reminders.changed': { reminders: Reminder[] }
  }
}
