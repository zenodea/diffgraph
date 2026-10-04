# graphdiff

A [herdr](https://herdr.dev) plugin for keeping track of what your coding agent changed.
Press `prefix+g` in a pane and your browser opens a live review page for that pane's repo.

- **A map of the change.** The home view is a graph of the repo's folders branching out
  to the files that changed, so you can see at a glance whether it was the backend, the
  frontend, or both. Thicker branches changed more; untouched files fold into one grey
  "n unchanged" node per folder. Each file's dot fills like a pie with how much of the
  file changed. Hover a file to see what it imports and which files use it (unchanged
  importers show up faded, so you can see how far a change could reach). Files that are
  new or updated since you last looked get a small tag. Click a name to open its diff.
- **What changed, in words.** A side panel on the map gives one plain sentence for the
  whole change and one per folder, written by a small model (Claude Haiku by default)
  and cached until that folder changes. Hover one to light up its branch.
- **A file list too**, with the number left to review always in view. Folders show how
  many of their files you've done.
- **Review mode, when you want it.** By default the page is just for looking around.
  Switch on Review (`r`) to get a progress count, ticks on files and folders, and
  "Mark reviewed". Reviewed means reviewed: mark a file (space) and you move on to the next
  one. If the agent edits it again, it goes back to "edited again", and you can see just
  what changed since you last looked.
- **Three ways to read a diff:** unified, side by side, or the full file with changes
  highlighted and removed lines folded away.
- **Live.** The page updates as the agent writes; just-changed files flash, and the top bar
  shows whether the agent in your pane is still working.
- **Why it changed.** For each file, the prompt that led to it and what the agent said
  before editing, read from Claude Code, Codex or pi session transcripts.
- **Ask about it.** Click line numbers (shift-click for a range) and ask. Enter asks a
  read-only side agent and the answer shows up right under the lines; ⌘Enter sends the
  question to the agent in your herdr pane instead.
- **Scopes:** everything on the branch, only uncommitted work, or only what this pane's
  agent session touched.

## Install

```sh
herdr plugin install zenodea/graphdiff
```

Or from a clone, for development:

```sh
npm install && npm run build
herdr plugin link "$PWD"
```

Then bind it in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+g"
type = "plugin_action"
command = "graphdiff.open"
description = "graphdiff"
```

## Keys

| key | |
| --- | --- |
| `g` | switch between the map and the files |
| `Enter` | open the selected file (on the map) |
| `j` / `k` | next / previous file |
| `r` | review mode on / off |
| `n` | next file still to review (review mode) |
| `space` | mark reviewed and move on, again to undo (review mode) |
| `h` | hide reviewed files (review mode) |
| `1` `2` `3` | unified / split / full file |
| `a` | ask about the selected lines (or the file) |
| `Esc` | clear the line selection |

## How it works

`graphdiff.open` starts a small local server (once; it exits after 30 idle minutes) and
opens `http://127.0.0.1:4777/r/<repo>?t=<token>`. The server only answers on loopback
and every API call needs the token, which is stored in herdr's plugin state directory.
Review marks, question threads and snapshots of reviewed files live there too.

`herdr plugin action invoke graphdiff.stop` stops the server.

## Config

Optional, in `$(herdr plugin config-dir graphdiff)/config.json`:

```json
{
  "port": 4777,
  "base": "main",
  "ask": {
    "command": ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
    "format": "text"
  }
}
```

Folder summaries can be switched off with `"summary": { "enabled": false }`, or pointed
at another command with `"summary": { "command": [...], "format": "text" }` (prompt on
stdin, one sentence on stdout).

`base` is the branch to compare against (detected when left out). `ask.command` is what
answers questions inline. It gets the prompt on stdin and runs in the repo. The default is
`claude -p` with read-only tools, and `"format": "claude-stream-json"` streams its answer.
Any other command works with `"format": "text"`, which shows its stdout as the answer.

## Development

```sh
npm run dev        # rebuild the page on change
npm run serve      # run the server in the foreground
npm run typecheck
npm test
```
