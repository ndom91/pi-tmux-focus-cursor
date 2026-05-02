# pi-tmux-cursor-focus

A Pi extension that hides the editor cursor in unfocused tmux panes.

It wraps the active Pi editor instead of replacing it, so it works alongside prompt/status-bar extensions such as `pi-glance`.

## Install

```bash
pi install npm:pi-tmux-cursor-focus
```

## Test locally without publishing

From this package directory:

```bash
pi -e .
```

Or with an absolute path:

```bash
pi -e /path/to/pi-tmux-cursor-focus
```

## tmux setup

Enable tmux focus events:

```tmux
set -g focus-events on
```

Reload tmux after changing the config:

```bash
tmux source-file ~/.tmux.conf
```

## What it does

- Detects the current `TMUX_PANE`.
- Installs tmux focus hooks for that pane.
- Hides Pi's fake editor cursor when the pane loses focus.
- Restores the cursor when focus returns.
- Keeps any existing editor wrapper instead of replacing it.

## Release

Dry-run the release flow:

```bash
pnpm release
```

Publish a new version:

```bash
pnpm run do-release -- patch
```

The release script bumps `package.json`, checks Pi can load the extension, verifies the package tarball, runs `pnpm publish --dry-run`, then publishes with pnpm. If the package is in a git repo, it also creates and pushes a release commit/tag unless `--no-git` is passed.

## Notes

- Focus is tracked per tmux pane.
- If Pi is launched outside tmux, the extension stays inert.
- If tmux focus events are disabled, Pi cannot receive reliable focus updates.
