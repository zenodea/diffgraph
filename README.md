# graphdiff

**See the shape of what your coding agent changed.**

graphdiff is a [herdr](https://herdr.dev) plugin. Press `prefix+g` in a pane and your
browser opens a live map of that repo's changes: which folders were touched, how much,
and what depends on what. It's for getting a feel for a change before (or instead of)
reading every line of it.

![The map: folders branch out to the files that changed](docs/screenshots/map.png)

## Install

```sh
herdr plugin install zenodea/graphdiff
```

Then bind it in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+g"
type = "plugin_action"
command = "graphdiff.open"
description = "graphdiff"
```

Press `prefix+g` in any pane that's inside a git repo.

## What you get

### The map

Your repo as a tree, but only the parts that changed. Each folder is a branch. Thicker
branches changed more, so the heavy parts stand out. Each file's dot fills like a pie
with how much of that file changed, so a two-line tweak and a rewrite look different.
Untouched files fold into one grey "n unchanged" node per folder.

It's live: as the agent writes, files flash, new ones appear and the rest glide out of the
way. Pan with two fingers, pinch to zoom, press `0` to fit.

### Imports

Turn on **Imports** and hover a file to see what it imports and which files use it.
Unchanged files that depend on the change show up faded, so you can see how far it
could reach. Works for TypeScript/JavaScript, Python and Go.

![Hovering shared/types.ts shows everything that imports it](docs/screenshots/imports.png)

### What changed, in words

Turn on **Summary** and pick a folder (or the whole change) to get one plain sentence
about it. Summaries are written by a small model when you ask for them, and cached
until that folder changes.

![One-line summaries per folder](docs/screenshots/summary.png)

### The diff, when you want it

Click a file to read it: unified, side by side, or the whole file with removed lines
folded away. Syntax colours and word-level highlights included. If the agent's session
transcript is around (Claude Code, Codex or pi), a "why" panel shows the prompt that led
to the change.

![A split diff](docs/screenshots/diff.png)

### Ask about it

Click line numbers (shift-click for a range) and ask. Enter asks a read-only side agent
and the answer appears right under those lines. `⌘Enter` sends the question to the agent
in your herdr pane instead.

![An answer, anchored to the lines it's about](docs/screenshots/ask.png)

### Review mode

By default graphdiff is just for looking. Switch on **Review** (`r`) when you want to
work through a change: a count of what's left, ticks on files and folders, and
`space` to mark a file reviewed and jump to the next. If the agent edits a file you've
already reviewed, it's flagged as "edited again".

![Review mode, with three files ticked off](docs/screenshots/review.png)

## Keys

| key | |
| --- | --- |
| `g` | map ⇄ files |
| `j` `k` · `Enter` | select · open |
| `+` `−` `0` | zoom in, out, fit |
| `1` `2` `3` | unified, split, full file |
| `a` | ask about the selection |
| `r` | review mode (then `space` marks reviewed, `n` jumps to the next) |
| `?` | what everything means |

## Scopes

- **Branch:** everything since the branch left `main` (or `master`), plus uncommitted work.
- **Uncommitted:** only what isn't committed yet.
- **Session:** only what the agent in this pane touched since its session started.

## Config

Optional, in `$(herdr plugin config-dir graphdiff)/config.json`:

```json
{
  "port": 4777,
  "base": "main",
  "ask": { "command": ["codex", "exec", "--sandbox", "read-only", "-"], "format": "text" },
  "summary": { "enabled": true }
}
```

- `base`: the branch to compare against (detected when left out).
- `ask.command`: what answers questions. It gets the prompt on stdin and runs in the repo.
  The default is `claude -p` with read-only tools, streamed. Any command works with
  `"format": "text"`.
- `summary`: switch summaries off, or point them at another command the same way.
  The default is Claude Haiku with no tools.

## How it works

`graphdiff.open` starts a small local server once and opens
`http://127.0.0.1:4777/r/<repo>?t=<token>`. The server only listens on loopback, every
request needs the token, and it exits after 30 idle minutes. It reads your repo with
`git`, watches it for changes, and keeps review marks and question threads in herdr's
plugin state directory. Nothing leaves your machine except the prompts you choose to
send to a model (questions and summaries).

`herdr plugin action invoke graphdiff.stop` stops the server.

## Development

```sh
npm install
npm run dev        # rebuild the page on change
npm run serve      # run the server in the foreground
npm run typecheck
npm test
herdr plugin link "$PWD"
```

```
src/
  cli.ts            open / serve / stop
  server/
    core/           HTTP, live events, config, herdr
    git/            scopes, changed files, diffs
    review/         review marks
    agents/         transcripts, "why", questions, summaries
    deps/           import graph
  web/
    app/            page shell and top bar
    map/            the map, layout, pan and zoom
    files/          file list, file pane, "why"
    diff/           diff views, highlighting
    ask/            questions and answers
    styles/         one stylesheet per area
docs/               landing page and screenshots
```
