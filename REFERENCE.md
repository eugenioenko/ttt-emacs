# Emacs Mode

An Emacs compatibility layer for ttt, implemented entirely as a Lua plugin.

> **Requires ttt 1.1.0 or newer** (plugin API v2): the key interceptor's
> precedence over Escape and chords, `ttt.set_status_item`, and
> `ttt.exec_command`.

## Setup — the keybinding overlay

Five of the keys Emacs needs are claimed by ttt commands that register a
**force key**. On ttt releases up to and including v1.1.0, force keys are
matched *above* the plugin key interceptor (`internal/ui/root.go`,
`HandleEvent`), so without the overlay below those keys never reach the plugin
at all — `C-p` opens the command palette, `C-t` opens the terminal, and the
plugin looks broken. **On those versions the overlay is required.**

ttt PR #425 narrows the force-key check to the two cases it exists for — a raw
key consumer (the integrated terminal) having focus, or an overlay being open —
so during ordinary editing all five keys reach the plugin on stock bindings.
Once you are on a ttt containing that change the overlay is optional; it stays
harmless either way, and the test suites install it unconditionally.

```sh
cp keybindings.emacs.json ~/.config/ttt/keybindings.json
```

| ttt command | moved to | frees | Emacs command |
|---|---|---|---|
| `sidebar.toggle` | `F9` | `C-b` | backward-char |
| `command.palette` | `F5` | `C-p` | previous-line |
| `terminal.toggle` | `F8` | `C-t` | transpose-chars |
| `editor.quit` | `F4` | `C-q` | quoted-insert |
| `terminal.fullscreen` | `F7` | `M-t` | *(transpose-words, not yet implemented)* |

`keybindings.json` **merges** with the defaults (`MergeKeybindings` in
`internal/config/keybindings.go`), so only these five commands change; use `""`
as the key to unbind a command outright.

Three constraints shaped the choice of replacements, and any alternative has to
respect all three:

- **No core change is needed.** `internal/app/commands.go` only registers a
  force key in the single-step branch (`if config.ForceKeyCommands[cmdID]`
  inside the non-chord `else`), so *any* rebinding of the command frees the
  original key.
- **Not `ctrl+k` chords.** With Emacs mode on, `C-k` is `kill-line` and the
  plugin consumes it, so the chord never starts — every `ctrl+k x` binding is
  unreachable while the plugin is enabled. (`ctrl+k b` and `ctrl+k m` are also
  already taken, by `panel.toggle` and `editor.goToMatchingBracket`.)
- **Function keys, so the escape hatches stay force keys.**
  `terminal.toggle` in particular *must* remain a single key: it is the only
  way out of the integrated terminal once the terminal widget is consuming raw
  keys. As a chord it would leave you trapped. `F5`, `F7`, `F8` and `F9` are
  unbound in both ttt and `emacs -Q`.
- **`F4` is a judgement call.** ttt does not bind it and neither does the
  editing core of Emacs, but real Emacs has `F4` on `kmacro-end-or-call-macro`.
  ttt-emacs puts macros on `C-x (` / `C-x )` / `C-x e` and never reads `F4`, so
  the collision is nominal. Keeping `editor.quit` on a *single* key preserves it
  as a force key, which matters because it is the prompt-on-unsaved-changes exit.
  Move it anywhere you like — `C-x C-c` quits regardless.

## Status

| Area | State |
|---|---|
| Prefix keymap trie (`C-x`, `C-x r`, `C-h`), universal argument | ✅ |
| Movement, mark and region, kill ring | ✅ |
| Editing, case, transpose, open-line | ✅ |
| Keyboard macros (`C-x (` / `)` / `e`) | ✅ |
| `M-x`, `C-x C-f`, `C-x b`, `C-x k` (bridged to ttt's overlays) | ✅ |
| Incremental search (`C-s` / `C-r`) | ✅ |
| query-replace (`M-%`) | ⏳ stubbed |
| Rectangles and registers (`C-x r …`) | ⏳ stubbed |

Behaviour is pinned against **GNU Emacs 27.1 in `fundamental-mode`** by a
differential fuzzer (`tests/fuzz/`) that compares `{text, point, mark,
regionActive}` after every key. Where this document says "verified", it means a
real Emacs was asked.

## Supported today

### Movement

| Key | Command |
|---|---|
| `C-f` `C-b` `<right>` `<left>` | forward-char / backward-char |
| `C-n` `C-p` `<down>` `<up>` | next-line / previous-line |
| `C-a` `C-e` `<home>` `<end>` | move-beginning-of-line / move-end-of-line |
| `M-f` `M-b` | forward-word / backward-word |
| `C-v` `M-v` `<pgdn>` `<pgup>` | scroll-up-command / scroll-down-command |
| `M-<` `M->` | beginning-of-buffer / end-of-buffer |
| `C-l` | recenter-top-bottom (centre → top → bottom) |

### Mark and region

| Key | Command |
|---|---|
| `C-SPC` | set-mark-command |
| `C-u C-SPC` | pop the mark ring back to the previous mark |
| `C-x C-x` | exchange-point-and-mark |
| `C-x h` | mark-whole-buffer |

The region is drawn with ttt's own selection, so it is visible exactly when
Emacs would call it active.

### Editing

| Key | Command |
|---|---|
| `C-d` `<delete>` | delete-char / delete-forward-char |
| `DEL` | delete-backward-char |
| `C-k` | kill-line |
| `C-y` `M-y` | yank / yank-pop |
| `C-w` `M-w` | kill-region / kill-ring-save |
| `M-d` `M-DEL` | kill-word / backward-kill-word |
| `M-u` `M-l` `M-c` | upcase-word / downcase-word / capitalize-word |
| `C-t` | transpose-chars |
| `C-o` | open-line |
| `C-q` | quoted-insert |
| `C-/` `C-x u` | undo |
| `C-g` | keyboard-quit |

### Incremental search

| Key | Command |
|---|---|
| `C-s` | isearch-forward — start, or repeat forwards |
| `C-r` | isearch-backward — start, or repeat backwards |
| *printable* | add to the search string and re-search |
| `DEL` | back to the previous search state |
| `RET` `Esc` | exit, leaving point at the match |
| `C-g` | drop the failed characters, or abort back to where the search started |
| *anything else* | exit the search, then run that key normally |

The prompt is the echo area: `I-search: foo`, `I-search backward: foo`,
`Failing I-search: foo`, `Wrapped I-search: foo`. Matches are highlighted with
ttt's own find highlight for as long as the search is live.

### Files, buffers and commands

| Key | Command | Bridges to |
|---|---|---|
| `M-x` | execute-extended-command | `command.palette` |
| `C-x C-f` | find-file | `file.quickOpen` |
| `C-x b` | switch-to-buffer | `file.quickOpen` |
| `C-x k` | kill-buffer | `tab.close` |
| `C-x C-s` | save-buffer | `file.save` |
| `C-x C-c` | save-buffers-kill-terminal | `editor.quit` |
| `C-h b` `C-h C-h` | describe-bindings | a dialog built from the trie |

### Keyboard macros

| Key | Command |
|---|---|
| `C-x (` | start-kbd-macro |
| `C-x )` | end-kbd-macro |
| `C-x e` | call-last-kbd-macro (a bare `e` repeats it) |
| `C-u {n} C-x e` | replay `{n}` times |

### Universal argument

`C-u`, `C-u C-u` (16), `C-u {digits}`, `C-u -`, and `M-{digit}` / `M--`. Every
command takes it; a self-inserting key with a count inserts that many copies.

## Design

### The dispatcher is a trie, not a mode machine

ttt-vim routes keys through `handle_normal` / `handle_insert` / `handle_visual`
because *mode* is Vim's primary axis. **Emacs has no modes.** Its primary axis is
the prefix keymap, so `init.lua` builds a trie: every node is either a command
(`{ name, run }`) or a keymap (`{ prefix, map }`), and a keystroke either
descends, runs, self-inserts, or falls through to the editor.

The entire prefix state is two fields — `state.map` (which keymap we are inside)
and `state.path` (how we got there) — plus `state.arg` for `C-u`. Adding `C-c` or
`M-g` later is one table literal and no dispatcher change. There is no mode
state machine here and there must never be one.

Unrecognized keys fall through (`return false`) so ttt's own bindings keep
working; unrecognized *printable* keys fall through too, which is what makes
self-insert cost nothing and keeps ttt's typing path — auto-indent, bracket
matching, undo coalescing — in charge of typing.

### The echo area is the status bar, not `ttt.command_line`

`ttt.command_line` is a modal overlay, and overlays are handled **above** the
plugin key interceptor (`handleOverlay` runs before `KeyInterceptor` in
`internal/ui/root.go`). While one is open the plugin receives **zero**
keystrokes. That is fatal for any Emacs prompt that has to keep reading keys *as
Emacs commands*: `C-g` to abort, `C-s C-s` to repeat a search, `DEL` to
backtrack. So messages and prompts are rendered with `ttt.set_status_item`,
which is not focusable and leaves the plugin holding the keyboard. `echo(msg)`
and `signal(msg)` are the whole API, and incremental search — the one prompt
that really does read Emacs commands — is built on them.

The status bar carries two items: `echo` for the message, and `mode` for the
*transient* indicators (a pending prefix `C-x-`, a universal argument `C-u 4`,
`C-q-`, `Def` while recording a macro). There is deliberately **no idle label**:
Vim shows one because it is modal and the label says what the next keystroke
will do, but Emacs is not modal and has no such indicator, so when nothing is
pending the slot is removed rather than filled with a constant.

The *completing* prompts deliberately go the other way. `M-x`, `C-x C-f` and
`C-x b` hand over to ttt's own overlays, because those are prompts that own the
keyboard in Emacs too, `Escape` dismisses them, and it buys real completion that
no plugin API could provide.

### The kill ring

A flat list, newest first, capped at 60 (`kill-ring-max`), with an index that
`C-y` reads and `M-y` rotates. No named registers, no delete ring, no
linewise/charwise kind — Emacs has none of those. The interesting part is the
*chaining*, which is modelled on Emacs's `last-command` rather than
approximated:

- `kill_save()` sets `state.this_kill`, mirroring `kill-region` setting
  `this-command`; `finish_command` copies it to `state.last_kill`. Consecutive
  kills therefore append into one entry, and backward kills (`M-DEL`) prepend, so
  the entry always reads in buffer order.
- A kill that **signals** does not extend the chain — `C-k` at end of buffer
  never reaches `(setq this-command 'kill-region)`.
- `M-w` does not *start* a chain: `copy-region-as-kill` never sets
  `this-command`, so `M-w C-k` makes two entries. Verified and tested.
  It nominally appends to a chain already in progress, but that is
  **unreachable here**: every kill deactivates the mark in `finish_command`, so
  an `M-w` straight after a kill has no active region and refuses with "The
  mark is not active now" — and re-activating a region requires a non-kill
  command, which clears `last_kill`. `C-k M-w` therefore makes two entries, not
  one, and the `quiet` branch of `kill_save` is dead code in practice.
- A **refused** `C-w` *does* arm the chain, because `kill-region` is itself the
  symbol `kill-append` tests for and the command loop sets `this-command` before
  the interactive spec signals. This makes an Emacs quirk reachable, and the
  quirk is reproduced on purpose: appending onto an *empty* ring signals after
  the text has already been deleted, so `C-w C-k` deletes the line and stores
  nothing.

### Incremental search: a state machine, a backtrack stack, and one way out

isearch is the reason the echo area is the status bar. It is also the only part
of the plugin that owns the keyboard for more than one keystroke, so it is
written as an explicit state machine rather than as a set of commands.

`state.isearch` is nil unless a search is running, and otherwise holds all of
it: `str` (literal, never a regexp), `dir`, `origin` (point when the search
started), `barrier`, `match`, `failing`, `wrapped` and `stack`. The dispatcher
checks that one field first, before the prefix trie and before the universal
argument, and routes the key to the isearch keymap.

**The backtrack stack.** `DEL` is `isearch-delete-char`, which undoes the last
*command*, not the last character. A snapshot — string, point, match,
direction, failing, wrapped, barrier — is pushed after every isearch command,
including the one that starts the search, so the stack always has a floor that
`DEL` will not pop. `C-s f o o C-s DEL` therefore returns to the **first** match
of `foo`; it does not become a search for `fo`. `C-g` uses the same stack for
its first stage.

**`C-g` is two commands in one key** (`isearch-abort`): while the search is
*failing* it pops states until one succeeded — "rub out the characters that made
it fail" — and stays in the search. While it is succeeding it aborts outright,
returning point to `origin`. The abort does not remember the search string.

**Exit and redispatch.** Any key isearch does not handle itself ends the search
and is then executed normally, which is `isearch-other-meta-char`. This is the
one place this section reaches back into the dispatcher, and the order matters:
the search is torn down **first**, so the recursive `dispatch()` cannot land
back in the isearch keymap, and its return value is passed through, so a key ttt
owns still falls through to the editor. Losing the key here would read as "the
plugin ate my keystroke".

**Emacs rules that are easy to get wrong**, each checked against 27.1 through
the differential oracle rather than guessed:

- **Forward search leaves point at the END of the match, backward at its
  BEGINNING**, and *changing direction lands on the other end of the same
  match* — `isearch-repeat` flips the direction and searches again from point,
  which re-finds what is already there.
- **A typed character extends the current match in place when it can.** Forward,
  the search resumes from the *start* of the current match, so the match may
  stay where it is or move later. Backward, a match that still begins where this
  one does is kept and point does not move at all, provided it does not reach
  past the search origin (the `barrier`).
- **Typing while the search is failing does not search.**
  `isearch-search-and-update` only runs while the search succeeds, so failed
  characters pile onto the string with point untouched — which is what makes
  `C-g`'s first stage meaningful.
- **A failing search does not move point.** Emacs restores point from the last
  pushed state, including after a wrap that found nothing.
- **Exiting pushes the mark where the search started** (`isearch-done`), so
  `C-x C-x` jumps back — but **not** when a region is already live, because
  pushing would move the mark out from under it, and not when point never moved.
  A live region survives the whole search and follows point to the match.
- **Smart case** is `isearch-no-upper-case-p`: a search string that is all lower
  case folds case, and one upper-case character makes the search
  case-sensitive. The test is per *rune*, not a `%u` byte match, which would
  call the `0xC3` lead byte of a two-byte rune upper case.
- **`C-s` with an empty search string reuses the last string** and searches for
  it from point. That is the whole of the search ring here (see "Known gaps").
- Match highlighting goes through `editor.set_search`, which is always
  case-*sensitive* for a plain pattern, so a case-folding search hands it a
  quoted regexp with an inline `(?i)` instead. The plugin's own matching stays
  literal either way — a rune-array comparison, so multi-byte lines behave and
  no regexp engine is needed. The search string can never contain a newline
  (`RET` exits), so a match never spans lines.

### The editor shim keeps positions valid across edits

There is no buffer-change event carrying positions (`editor.change` fires with a
path only), so `editor.insert` and `editor.replace` are wrapped in a table that
forwards everything else to the real module through `__index`. The wrappers move
the mark, the mark ring and the yank extent.

This matters more here than in ttt-vim: a Vim mark is a line number with a
best-effort column, but an Emacs mark is one *end of the region*, so a wrong
column silently kills the wrong text. Columns are adjusted too, which ttt-vim
does not do. Insertion **exactly at** a tracked position leaves that position
alone — Emacs markers have insertion-type nil — which is what puts the mark at
the *start* of what `C-y` just inserted.

### Emacs semantics that are easy to get backwards

Each of these cost a differential-fuzzer round trip; they are listed so the next
change does not undo one.

- **`C-k` with `kill-whole-line` nil.** Before the end of a non-empty line it
  kills to end of line and *not* the newline, even at column 1. At the end of a
  line — which includes every empty line — it kills the newline.
- **Vertical motion at the buffer edge.** `line-move-1` moves as far as it can
  and *then* signals, so `C-p` on the first line leaves point at `point-min` and
  `C-n` on the last line at `point-max`. It does **not** stay put, and with
  `next-line-add-newlines` nil it must not grow the buffer.
- **The goal column only survives between consecutive line-move commands**
  (`temporary-goal-column` is read only when `last-command` is `next-line` or
  `previous-line`). A self-inserting key in between resets it. `track-eol` is
  nil, so the goal is a column and does not stick to end-of-line.
- **`DEL` deletes an active region.** `delete-active-region` defaults to `t`, so
  `delete-backward-char` with a live region deletes the whole region — and
  *deletes* it, with no kill-ring entry. `<delete>` (`delete-forward-char`) does
  the same; `C-d` (`delete-char`) does **not**.
- **A command that signals changes nothing else.** It does not deactivate the
  region and does not extend the kill chain. `C-k` at end of buffer followed by
  `C-w` must still kill the region.
- **`M-<` / `M->` push the mark only when the region is inactive**
  (`(or (consp arg) (region-active-p) (push-mark))`). Pushing unconditionally
  moves the mark out from under a live region.
- **`C-y` pushes the mark before it can fail.** `yank` runs `(push-mark)` ahead
  of `(current-kill)`, so `C-y C-x C-x` is a working pair on a fresh buffer even
  though the yank signalled "Kill ring is empty".
- **`C-x C-x` activates the region**, whatever it was before — verified against
  27.1 rather than read off `exchange-point-and-mark`'s `xor` clause, which
  reads as though an inactive mark should stay inactive.
- **`C-t` at end of line transposes the two *preceding* characters.** The
  command first steps back when `(eolp)`, then swaps the pair around point,
  leaving point after it. Written against the point model, that one rule also
  gives the start-of-line case (the newline is one of the two characters, so the
  character is dragged onto the previous line) and the empty-line case.
- **Word syntax is `standard-syntax-table`.** Word constituents are
  `A-Z a-z 0-9 $ %`; `_ - + * / & | < > =` are *symbol* syntax and
  `. , ; : ? ! # @ ~ ^ ' \`` are punctuation — neither is a word constituent. So
  `M-f` stops after `foo` in `foo_bar` and runs through the `%` in `50%`. Vim
  counts `_` as a word character and `%` as punctuation, so ttt-vim's classes are
  wrong in both directions and are deliberately not reused.
- **`M-c` capitalizes every word in its range**, so `M-3 M-c` capitalizes three;
  a range starting mid-word capitalizes that partial word (`he|llo` → `heLlo`).
- **No mark at all is not the same as an inactive mark.** `C-w` / `M-w` refuse
  both, with Emacs's two different messages. The refusal is a no-op: buffer,
  point and mark are untouched.

### Undo

`C-/` and `C-x u` delegate to `editor.undo`, and undo deactivates the region.
ttt coalesces a run of typed characters into one undo step, which matches
Emacs's amalgamation of consecutive `self-insert-command`s, and each plugin
command is bracketed in exactly one `begin_undo_group` / `end_undo_group` pair,
which matches Emacs's per-command undo boundary.

**Undo transactions do not nest.** `BeginTransaction` resets the transaction
start index (`internal/core/undo/undo.go`), so a second `begin` mid-operation
silently drops everything before it from the group. One bracket per command, and
never around a call that runs a core command — core opens its own.

## Known gaps

- **`C-/` is unreliable through the `--exec` harness, and only there.**
  `comboToTcell` encodes `ctrl+space` as `tcell.KeyNUL` and `ctrl+/` as
  `tcell.KeyUS`, neither of which has an entry in `tcell.KeyNames`, so
  `internal/plugin/event_convert.go` reports **both** as `key="unknown"` and the
  plugin cannot tell them apart. `C-SPC` wins, because undo also has `C-x u`.
  Real terminals are unaffected: tcell's legacy decoder delivers `ctrl+space` as
  rune `" "` and `ctrl+/` as rune `"_"`, both with `ModCtrl`, and the kitty
  protocol is likewise unambiguous — the plugin handles all of those spellings.
  A six-line core fix would clear it, and `token_of` already accepts the result:

  ```go
  // internal/plugin/event_convert.go
  name := tcell.KeyNames[e.Key()]
  if name == "" {
      switch e.Key() {
      case tcell.KeyNUL:
          name = "Ctrl-Space"
      case tcell.KeyUS:
          name = "Ctrl-/"
      default:
          name = "unknown"
      }
  }
  ```

  This shipped as ttt PR #427, which names them for the ttt keybinding spelling
  (`ctrl+space`, `ctrl+/`) rather than Emacs's `C-_`, so a plugin keymap written
  against ttt's own vocabulary round-trips. Until you are on a ttt carrying it,
  the differential fuzzer cannot exercise `C-/` and every generated sequence
  containing it reports a divergence.
- **Undo boundaries do not match Emacs after a kill.** `C-/` and `C-x u`
  delegate to `editor.undo`, and ttt's notion of an undo step is its own. A run
  of self-inserts coalesces correctly — `a b c C-/` restores the buffer in one
  step and leaves point where Emacs leaves it — but undo *after a kill* drifts,
  in both the resulting text and point. Measured over 200 fuzz seeds on a ttt
  carrying #427: 164 matched, 36 diverged, and 33 of the 36 contain `C-/`.
  Closing this means
  reimplementing Emacs's undo-boundary rules against a stack the plugin does not
  own, so it is deliberately not attempted. The affected cases are pinned in
  `tests/fuzz/differential.test.js` under `KNOWN_DIVERGENCES`.
- **The empty region is not treated as Emacs treats it.** The other 3 of those
  36 seeds, minimized and pinned alongside the undo cases. Neither has anything
  to do with isearch — both still diverge with the search tokens stripped out —
  and both live in rules this document already states, one step further:
  - `use-empty-active-region` is nil, so an **empty** active region is not a
    region for `delete-backward-char`: `C-f C-SPC DEL` deletes the character
    before point. ttt-emacs takes the delete-active-region path for any active
    region and so deletes nothing.
  - **An empty kill is still a kill-ring entry.** `kill-new ""` pushes, so
    `C-y` after one yanks *nothing*; ttt-emacs drops empty kills and `C-y` then
    yanks the previous entry — a whole line appearing out of nowhere. `M-d` at
    `point-max` is the same story from the other side: Emacs does not signal
    there, it kills the empty region and the ring head becomes `""`.
- **isearch has one search string of history and none of the extras.**
  `C-s` on an empty string reuses the last string, which is what `C-s C-s`
  needs, but there is no search *ring* (`M-p` / `M-n`), no `C-w` / `C-y` /
  `M-y` yanking into the search, no regexp isearch (`C-M-s`), no word or symbol
  search, and no `M-e` to edit the string. Every one of those keys takes the
  exit-and-redispatch path instead, so `C-s foo C-w` exits the search and kills
  the region rather than pulling the next word into it. `TAB` likewise exits and
  indents, where Emacs would add a tab to the search string.
- **query-replace (`M-%`) is a stub.** It wants the same echo-area prompt
  isearch is built on, plus a per-match `y`/`n`/`!` keymap. `Ctrl+R` (ttt's own
  replace) remains available.
- **Rectangles and registers (`C-x r …`) are stubs.** Present as a keymap so
  `C-x r k` does not leak a stray `k` into the buffer.
- **`C-x C-w` (write-file) is a stub.** `file.saveAs` opens its own dialog and
  cannot be given a path — `command.Command.Handler` is `func()` and takes no
  arguments — and `ttt.fs.write` refuses any path outside a workspace folder.
- **`C-x b` is `C-x C-f`.** ttt has no buffer list distinct from its file list,
  so switch-to-buffer lands on the same quick-open overlay.
- **`C-q` inserts printable characters, `RET` and `TAB` only.** `C-q C-f` does
  not insert a literal `^F`, and the octal form (`C-q 1 0 1`) is not parsed.
- **Only one mark ring, and it is not per-buffer.** Switching tabs does not
  switch the mark, the mark ring or the kill ring.
- **A macro only replays keys the plugin owns.** Pass-through keys (arrows,
  `Ctrl+S`, chords) are recorded but do nothing on replay, because the replay
  feeds tokens to the plugin dispatcher rather than to the terminal. Typed text
  *is* replayed — the dispatcher inserts it directly.
- **`M-t` (transpose-words), `M-\`, `M-^`, `M-;` and the rest of the Meta
  editing set are not implemented.** `M-t`'s key is freed by the overlay above,
  so adding it is a keymap entry and a command.
- **The system clipboard is one-way.** `emacs.clipboard` mirrors kills to it
  through `editor.copy` (there is no clipboard binding in the plugin Lua API),
  but `C-y` always reads the plugin's own kill ring.

## Configuration

`settings.json`, under an `emacs` object; both keys are in the manifest's
`settings_keys` allowlist.

| Key | Type | Default | Effect |
|---|---|---|---|
| `emacs.enabled` | bool | `true` | When `false`, start with Emacs mode off (re-enable from the command palette). |
| `emacs.clipboard` | bool | `false` | Mirror every kill to the system clipboard, reusing the `editor.copy` path. |

Settings are read one tick late, in a `ttt.set_timeout(0, …)`: `LoadAll` calls
`Init` before `WirePlugin`, so `ttt.settings` *and* `ttt.set_status_item` are
both nil while `init.lua` is executing.

Commands: `Emacs: Toggle Emacs Mode`, `Emacs: Enable Emacs Mode`,
`Emacs: Disable Emacs Mode`, `Emacs: Describe Bindings`.

## Notes for the next change

**Single file.** The plugin sandbox strips `package.loaders` down to the preload
loader (`internal/plugin/sandbox.go`), so a plugin cannot `require` sibling
`.lua` files.

**Lua 5.1, with gopher-lua's quirks.**

- **Multiple assignment does not swap.** `a, b = b, a` evaluates to `b, b`. This
  is a gopher-lua register-allocation bug, not Lua semantics. Every swap here
  goes through separate names — `exchange-point-and-mark` is where you would
  naturally write the broken form.
- **200 locals per function.** The main chunk is one function; keep related
  helpers in tables (`cmds`, `KEYMAP`) rather than adding top-level locals. The
  file currently uses roughly 80 of the 200.
- **No `%g` class, no `goto`, no `utf8` library.** Rune handling decodes UTF-8
  from the lead byte; character classes are byte ranges.

**Errors inside a `key.press` listener are swallowed** by the host and the key
falls through, which reads exactly like "the plugin ignored my key". Both the
dispatch entry point and each command handler are `pcall`ed, and failures are
surfaced with `ttt.notify`. Suspect a Lua error first when a binding
mysteriously does nothing.

**`PluginEditorAPI.Insert` rejects `line >= len(Lines)`**, so the line *after*
the last one cannot be addressed; append `"\n"` at the end of the current line
instead.

**`set_cursor` scrolls.** It calls `EnsureCursorVisible` on the Go side, so every
scrolling routine moves point *first* and calls `scroll_to` *last*; the other
order is silently undone.

**`set_selection` parks the cursor at the end of the range**
(`internal/app/plugin_api.go`), so the region is always painted by setting point
first and syncing afterwards with the same end position.

## Development

```sh
make -C /path/to/ttt build
bin/ttt --size 100x30 --plugin ~/.config/ttt/plugins/ttt-emacs/init.lua file.txt \
  --exec "wait 300; key ctrl+space; key ctrl+e; key alt+w; screenshot /tmp/s.txt; quit"
```

Always set `TTT_CONFIG_DIR` to a scratch directory for scripted runs, so the
real `~/.config/ttt` is neither read nor mutated — and remember that the
keybinding overlay above has to be in *that* directory for `C-b`, `C-p`, `C-t`
and `C-q` to arrive. `tests/fuzz/ttt-runner.js` writes it automatically from
`TTT_KEYBINDINGS` in `tests/fuzz/parity.js`.

Differential tests against real Emacs:

```sh
TTT_BIN=/path/to/ttt/bin/ttt node tests/fuzz/fuzz.mjs      # batch fuzz
TTT_BIN=... FUZZ_SEED=47 node tests/fuzz/fuzz.mjs          # one seed, verbose
```
