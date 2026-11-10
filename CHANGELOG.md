# Changelog

## 0.2.0

Needs Orca 1.4.248 or newer. Orca asks you to approve the update, because it adds two
capabilities (`workspace:write` to open a reminder's workspace, `settings:own` for settings), a
status bar item and four commands.

### New

- **Open** a reminder's workspace from the panel or the palette. Reminders from 0.1.0 find their
  workspace by name and branch.
- **Status bar** count of due and pending reminders; pressing it lists them.
- **Settings**: morning time (for tomorrow, next week and weekdays) and the status bar on or off.
- **More times**: `2d`, `in 3 days`, `friday`, `fri 14:00`, `next monday at 10`, `next week`.
- **Palette**: snooze due reminders 15 minutes, mark due reminders done, open the oldest due
  reminder's workspace.
- A reminder whose workspace was deleted says so and loses its Open button.
- A reminder that came due while Orca was closed fires at launch and says when it was due.
- Panel: bordered cards for pending reminders, Done and Cancel as icon buttons, a dismissable
  error, done reminders with when they were done, a cover image, screenshots and an icon for the
  catalog.

### Fixed

- A reminder longer than about 115 characters never notified: Orca refuses notification titles
  over 120 characters. Titles are now shortened to fit.
- **Reminders: Show pending reminders** showed nothing from the command palette, which drops a
  command's answer. It now shows a notification, and so do the "remind me" commands.
- If reading storage failed once inside the timer, nothing fired again until some workspace or
  agent event woke the plugin. A failed check now retries.

## 0.1.0

First release: reminders tied to a workspace or tab, desktop notifications, snooze, move, done,
cancel, palette commands and the list of agents needing you.
