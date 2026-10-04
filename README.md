# graphdiff

A [herdr](https://herdr.dev) plugin for keeping track of what your coding agent changed.
Press `prefix+g` in a pane and your browser opens a live review page for that pane's repo:
a tree of the changed files, how much is left to review, and the diff for each file.

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

## How it works

`graphdiff.open` starts a small local server (once; it exits after 30 idle minutes) and
opens `http://127.0.0.1:4777/r/<repo>?t=<token>`. The server only answers on loopback
and every API call needs the token, which is stored in herdr's plugin state directory.

`herdr plugin action invoke graphdiff.stop` stops the server.

## Config

Optional, in `$(herdr plugin config-dir graphdiff)/config.json`:

```json
{ "port": 4777, "base": "main" }
```

## Development

```sh
npm run dev        # rebuild the page on change
npm run serve      # run the server in the foreground
npm run typecheck
npm test
```
