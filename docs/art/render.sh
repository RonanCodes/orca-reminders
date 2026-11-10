#!/bin/sh
# Builds the catalog images in images/ from panel shots in $1 (busy-light.png, busy-dark.png,
# typed-light.png, typed-dark.png), taken with:
#   orca plugin shot . --scenario "busy light" --theme light --width 380 --out <dir>/busy-light.png
# Uses headless Chrome, which never shows a window.
set -e
cd "$(dirname "$0")/../.."
SHOTS="$1"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }
render() { # out shot theme title lead points
  cp "$SHOTS/$2" docs/art/.shot-$2
  url="file://$PWD/docs/art/compose.html?shot=$(enc .shot-$2)&theme=$3&title=$(enc "$4")&lead=$(enc "$5")&points=$(enc "$6")"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1600,1000 --screenshot="$PWD/images/$1" "$url" >/dev/null 2>&1
  rm -f docs/art/.shot-$2
}
LEAD="Park a thought on the workspace or tab it belongs to. Get a desktop notification when it is due."
render cover.png busy-light.png light "Remind me *later*." "$LEAD" "Snooze, move or tick off|Open the workspace again|A count in the status bar"
render panel-light.png busy-light.png light "Due, pending and *done*." "Due reminders wait at the top until you deal with them." "Snooze 15m, 1h or tomorrow|Open jumps back to the workspace|Agents that need you, below"
render panel-dark.png busy-dark.png dark "Due, pending and *done*." "Due reminders wait at the top until you deal with them." "Snooze 15m, 1h or tomorrow|Open jumps back to the workspace|Agents that need you, below"
render time-light.png typed-light.png light "Any time you can *type*." "Link it to the workspace or one of its tabs." "16:00, 4pm, 45m, 1h30m|tomorrow 10:30, 2d|friday 14:00, next week"
render time-dark.png typed-dark.png dark "Any time you can *type*." "Link it to the workspace or one of its tabs." "16:00, 4pm, 45m, 1h30m|tomorrow 10:30, 2d|friday 14:00, next week"
