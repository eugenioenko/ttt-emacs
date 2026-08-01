# ttt-emacs

An Emacs compatibility layer for the [ttt](https://github.com/eugenioenko/ttt)
editor, written as a single-file Lua plugin.

Prefix keymaps, the mark and the region, the kill ring, the universal argument
and keyboard macros — the subset of Emacs people actually use, with behaviour
pinned against GNU Emacs in `fundamental-mode` by a differential fuzzer.

## Install

```sh
git clone https://github.com/eugenioenko/ttt-emacs ~/.config/ttt/plugins/ttt-emacs
cp ~/.config/ttt/plugins/ttt-emacs/keybindings.emacs.json ~/.config/ttt/keybindings.json
```

**Restart the editor after installation** so the plugin can apply its settings.

**On ttt v1.1.0 and earlier the second line is required, not optional.** ttt
claims `C-b`, `C-p`, `C-t`, `C-q` and `M-t` for commands that register a *force
key*, and on those versions force keys are matched before any plugin sees them.
The overlay moves those five commands onto function keys:

| ttt command | moved to | frees |
|---|---|---|
| `sidebar.toggle` | `F9` | `C-b` backward-char |
| `command.palette` | `F5` | `C-p` previous-line |
| `terminal.toggle` | `F8` | `C-t` transpose-chars |
| `editor.quit` | `F4` | `C-q` quoted-insert |
| `terminal.fullscreen` | `F7` | `M-t` |

It merges with ttt's defaults, so nothing else changes. If you already have a
`keybindings.json`, add those five entries to it instead of overwriting.

Newer ttt narrows the force-key check to the cases it exists for — the
integrated terminal holding the keyboard, or an open overlay — so all five keys
reach the plugin on stock bindings and the overlay becomes optional. It remains
harmless if you keep it.

## Keys

| | |
|---|---|
| **Move** | `C-f` `C-b` `C-n` `C-p` `C-a` `C-e` `M-f` `M-b` `C-v` `M-v` `M-<` `M->` `C-l` |
| **Mark** | `C-SPC` `C-x C-x` `C-x h` `C-u C-SPC` |
| **Kill / yank** | `C-k` `C-w` `M-w` `C-y` `M-y` `M-d` `M-DEL` `C-d` `DEL` |
| **Edit** | `C-t` `C-o` `M-u` `M-l` `M-c` `C-q` `M-t` `M-\` `M-^` |
| **Undo** | `C-/` `C-x u` |
| **Files** | `C-x C-s` `C-x C-f` `C-x b` `C-x k` `C-x C-c` |
| **Commands** | `M-x` `C-g` `C-u` `C-h b` |
| **Macros** | `C-x (` `C-x )` `C-x e` |
| **Search** | `C-s` `C-r` — incremental: `DEL` backtracks, `C-g` aborts, `RET` exits, `M-p`/`M-n` history, `C-w` yanks next word |

`C-h b` (describe-bindings) lists every binding from inside the editor. Arrow
keys, `<home>`, `<end>`, `<pgup>` and `<pgdn>` work as their Emacs equivalents,
so the region follows them too.

`M-%` opens the Replace dialog; `C-x C-w` opens Save As. Not yet implemented
and stubbed with a message: rectangles and registers (`C-x r …`).

## Settings

```json
{ "emacs": { "enabled": true, "clipboard": false } }
```

`clipboard` mirrors every kill to the system clipboard. Emacs mode can also be
toggled from the command palette (`Emacs: Toggle Emacs Mode`).

## Documentation

[`REFERENCE.md`](REFERENCE.md) — the keymap trie, the kill-ring model, why the
echo area is the status bar, the Emacs semantics that are easy to get backwards,
and the known gaps.
