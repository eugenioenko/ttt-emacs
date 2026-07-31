# Differential fuzzer — ttt-emacs vs. real Emacs

A seeded, property-based conformance test. It generates a random sequence of
Emacs keystrokes, applies it to **ttt-emacs** and to **real Emacs** (the
oracle), and compares the resulting **buffer text, point and mark**. Identical
state ⇒ spec-compliant for that sequence. Divergence ⇒ a bug in ttt-emacs (or a
*known, allowlisted* intentional difference).

The whole point is to find the subtle semantic bugs that hand-written example
tests miss — off-by-one word boundaries, kill-ring append rules, undo grouping,
region activation edge cases — by letting a fuzzer explore the command space and
holding the result against the reference implementation.

## Why this works

ttt-emacs was built to match Emacs semantics, and Emacs is the de-facto spec.
Instead of encoding "what should `M-d` do at end of line" as an assertion, we
ask real Emacs and compare. The oracle is always right by definition, so every
divergence is either a real bug or something we consciously chose to do
differently (and must allowlist).

## The big win over the Vim harness: point and mark

`tests/fuzz` in **ttt-vim** drives Vim with `vim -s` and can only compare the
**saved file**. Cursor position is not observable that way, so an entire bug
class — "right text, wrong point" — is structurally invisible to it. (See its
FINDINGS.md B6: the post-undo off-by-one cursor bug was only caught indirectly,
because the misplaced cursor made *later* edits land in the wrong place.)

The Emacs oracle prints `(buffer-string)`, `(point)` and `(mark t)`, and ttt's
`--exec debug` dump reports buffer text, cursor and selection. So this harness
compares all three directly:

```
{ text: string, point: number, mark: number|null, regionActive: boolean }
```

`point` is a 1-based Emacs buffer position on both sides; `normalize.js`
converts ttt's 0-based `(line, col)` (col is a *rune* index) into one. A pure
motion sequence with no edits is therefore a real test rather than a no-op — the
majority of the alphabet is motion.

**Mark caveat.** ttt exposes the mark only *indirectly*, as the anchor of an
active selection in the debug dump, so an inactive-but-set Emacs mark (what
`C-w`, `M-w`, `M->`, `C-y` all leave behind) has nothing to compare against.
`normalize.js` therefore defaults to `markMode: "region"`: `regionActive` is
always compared, `mark` only when both sides report an active region. When
ttt-emacs grows a way to report its mark independently of the selection, flip
the default to `"strict"` (or run `FUZZ_MARK_MODE=strict`) — that is the single
place to change.

## Architecture

```
seed ─▶ generator ─▶ token[] ─┬─▶ ttt runner    ─▶ {text, point, mark}
                              └─▶ emacs oracle  ─▶ {text, point, mark}
                                        compareStates(...)
                              same ⇒ pass   diff ⇒ report {seed, tokens, diff}
```

| file | role |
| --- | --- |
| `rng.js` | mulberry32 seeded RNG — the ONLY source of randomness |
| `alphabet.js` | the fuzzable key set, each entry tagged with the command it exercises, plus the `DEFERRED` list |
| `generator.js` | seed → token stream, composed from small "actions" |
| `corpus.js` | starting buffers (`CORPUS`, 20 lines; `SMALL`, 5 lines) |
| `keys.js` | the token model shared by both sides: `tokensToEmacsKbd`, `tokensToTttKeys` |
| `emacs-oracle.js` | `runEmacs(text, tokens) → state` |
| `ttt-runner.js` | `runTtt(text, tokens) → state` |
| `normalize.js` | point arithmetic, `compareStates`, `diffStates` |
| `parity.js` | the one place both editing models are pinned |
| `differential.test.js` | vitest: fixed sequences through both sides |
| `fuzz.mjs` / `shrink.mjs` / `repro.mjs` | batch driver, delta-debugger, single-case repro |

## The token model

A **token** is one complete key sequence == one Emacs **command**:

- a named key, spelled as its canonical Emacs key description: `C-a`, `M-f`,
  `C-SPC`, `C-x C-x`, `DEL`, `RET`, `C-/`
- or exactly one printable ASCII character, which self-inserts: `a`, `(`, `"`,
  `" "` (a literal space)
- or a **compound** token: one complete incremental search, terminator included
  — `C-s beta RET`, `C-r beta RET`, `C-s beta C-s RET`, `C-s beta C-r RET`

`C-x C-x` is deliberately **one** token, not two. The one-token-one-command
invariant is what lets the oracle resume after an erroring command (below), and
it is why `C-u` (universal-argument, which merges with the *next* command) is on
the deferred list.

The compound token is the one deliberate exception, and it exists because
isearch is *interactive*: it reads keys until an explicit terminator, so a loose
`C-s` would leave both editors inside a search and every token after it would
mean something different on each side. A search carrying its own terminator is
deterministic. The exception is paid for in exactly one place — the oracle's
error-resume arithmetic, which maps a command count back to a token through
`tokenCommandCount` (`keys.js`) instead of assuming one command per token. A
compound is one command per *key*, measured, not guessed: `C-s t h e RET` is 5
commands, `C-x C-x` is still 1 (a prefix key completes no command). Getting that
mapping wrong does not fail loudly — the restart skips live tokens and the run
reports a divergence in a command that never ran.

Translation:

- **Emacs:** `tokensToEmacsKbd(tokens)` → one `kbd` description string *per
  token* (joining them with `" "` gives the single-macro form).
- **ttt:** `tokensToTttKeys(tokens)` → `--exec` steps; runs of literals coalesce
  into one `type`, named keys become `key <combo>`.

Two `--exec` parser constraints are handled in `keys.js` and are easy to
re-break: every step is `TrimSpace`d (so a literal space is emitted as
`key space`, never inside a `type` run) and `type` args are `stripQuotes`d (so a
run that both starts and ends with `"` is split).

## Driving each side

### Real Emacs (oracle) — HEADLESS, no PTY

```sh
emacs -Q --batch -l oracle.el
```

`-Q` (no init file, no site file) + `--batch` + a generated script is fully
deterministic: the only state is the fixture file and the token list. This is
strictly better than the Vim harness's `vim -s`, which needs raw-byte keystroke
files and a `<Esc>O` disambiguation hack — `kbd` parses key descriptions
unambiguously, so there is no escape-sequence ambiguity to work around here.

The verified recipe:

```elisp
(setq inhibit-message t line-move-visual nil)
(let ((buf (get-buffer-create "oracle")))
  (set-window-buffer (selected-window) buf)
  (with-current-buffer buf
    (fundamental-mode)
    (transient-mark-mode 1)
    (erase-buffer)
    (insert-file-contents "fixture.txt")
    (goto-char (point-min))
    (setq buffer-undo-list nil)
    (execute-kbd-macro (kbd "C-a C-k C-n C-e C-y"))
    (princ (format "%S %d %S" (buffer-string) (point) (mark t)))))
```

On `"hello world\nsecond line\nthird line"` this yields
`"\nsecond linehello world\nthird line"`, point 24, mark 13.

### Gotchas → design constraints

These are the difference between a useful fuzzer and a divergence generator.
The first three were verified experimentally; each fails **silently** when
violated.

1. **`execute-kbd-macro` operates on the SELECTED WINDOW's buffer, not the
   current buffer.** Without `(set-window-buffer (selected-window) buf)` the
   keys execute against `*scratch*`, and the oracle reports an empty buffer and
   a nonsense point with no error at all. Do not remove this line.

2. **`line-move-visual` must be nil.** Otherwise `C-n` / `C-p` signal
   `end-of-buffer` / `beginning-of-buffer`, because visual-line motion needs
   real window geometry that a batch frame does not have. Every vertical motion
   in the alphabet would report a bogus error.

3. **`inhibit-message` must be t** to keep stdout clean.

4. **An error inside `execute-kbd-macro` ABORTS the rest of the macro** — but
   the real command loop just rings the bell and reads the next key. Naively
   wrapping the whole macro in `condition-case` therefore truncates every
   sequence at its first `end-of-buffer`, which is *not* what ttt-emacs will do.
   The oracle runs the whole token list as **one** macro (preserving command-loop
   continuity, see gotcha 5) and, on a signal, records the failure and
   **restarts the macro at the following token**. A `pre-command-hook` counter
   identifies the offending token, walked back through the per-token command
   counts (`oracle-token-at`) — one per token everywhere except inside a
   compound isearch, which is one per key. `quit` (C-g) is a signal, not an
   error, so the handler catches `(error quit)`.

5. **Command-loop continuity is real state — do not run one token per
   `execute-kbd-macro`.** Measured on Emacs 27.1:

   | sequence | one macro | per-token macros |
   | --- | --- | --- |
   | `M-d M-d C-/ C-/` | both kills undone (correct) | second `C-/` *redoes* the first |
   | `a b c C-/` | all three chars undone (correct) | only `c` undone |

   Consecutive-undo chaining and self-insert undo amalgamation both depend on
   command-loop state that a fresh `execute-kbd-macro` invocation does not carry
   across. The single-macro-with-restart design in gotcha 4 exists to get both
   properties at once: correct continuity, plus errors that do not truncate.
   Continuity is only broken *at an error boundary*, which is also where the
   real command loop breaks it.

6. **The fixture insertion must be dropped from the undo list.** After
   `insert-file-contents`, `(setq buffer-undo-list nil)` — otherwise the first
   `C-/` undoes the fixture itself and empties the buffer. (`nil` re-enables
   recording; `t` would disable it. Also: never name the oracle buffer with a
   leading space — Emacs disables undo recording in such buffers.)

7. **Buffer-model parity — the trailing newline.** ttt's loader drops a file's
   final newline; with `editor.showTrailingNewline` on it then re-adds a
   navigable empty last line (this is ttt-vim FINDINGS.md F1, the phantom-line
   problem). Emacs's buffer model is the plain separator model. So `parity.js`
   pins `showTrailingNewline: false` **and** every fixture is written with **no
   trailing newline** — then `buffer.text.join("\n")` on the ttt side is
   byte-identical to `(buffer-string)`, with no normalization fudge at all. Both
   runners throw on a fixture ending in `"\n"` so this cannot regress silently.

8. **Nothing is saved.** Unlike the Vim harness there is no `:wq!` / `C-s` tail:
   state comes from ttt's `debug <path>` JSON dump and from the oracle's JSON
   output. That removes save-time transforms (`insertFinalNewline`,
   `trimTrailingWhitespace`) from the comparison entirely.

9. **Output framing must not be sentinel-based.** `TEXT<<...>>` breaks the
   moment a fuzzed buffer contains `>>`, which self-inserting `>` twice does
   immediately. The oracle writes a JSON file (via `json-encode` + `write-region`
   with `coding-system-for-write` pinned to `utf-8-unix`) and node reads it.

10. **Option parity lives in exactly one place.** `parity.js` holds
    `TTT_SETTINGS` (written into an isolated `TTT_CONFIG_DIR`) and `EMACS_SETUP`
    (elisp forms evaluated in the oracle buffer, each carrying the reason it is
    pinned, which is rendered as a comment into the generated script). A
    mismatch there is a false divergence, not a bug — when a new command class
    needs an option pinned, pin it there. See "Parity" below for what is pinned
    and why.

11. **Total determinism.** Fixed fixture, fixed token sequence, `-Q --batch` for
    Emacs, an isolated `TTT_CONFIG_DIR` for ttt (which also keeps the real
    `~/.config/ttt/plugins/` out of the run — auto-loaded plugins there would
    otherwise block on a one-time approval dialog). The *only* source of
    randomness is the seeded RNG; a run is byte-reproducible from its seed.
    `ttt-runner.js` fails loudly if an overlay is open at dump time, which is
    how a swallowed-keys run announces itself instead of silently "matching".

### ttt-emacs

```sh
ttt --size 160x50 --plugin init.lua --exec-split-on <US> --exec "<steps>" fixture.txt
```

with `TTT_CONFIG_DIR` pointed at a temp dir whose `settings.json` is
`parity.js`'s `TTT_SETTINGS`. The script is `wait` (plugin load) → the tokens →
`wait` → `debug <state.json>` → `quit`. State extraction:

- `text` = `state.buffer.text.join("\n")`
- `point` = `lineColToPoint(lines, state.cursor.line, state.cursor.col)`
- `mark` = the selection endpoint the cursor is *not* on (the debug dump reports
  a normalized start/end pair, so the anchor is recovered by elimination),
  `null` when no selection is active
- `regionActive` = `state.selection.active`

## Parity

`parity.js` is the only place either editing model is configured. It is
deliberately a **larger** set than the Vim harness's `VIM_SET`: Emacs has more
defaults that silently alter buffer content, and because we compare point and
mark, every option affecting *cursor* position matters too — a category the Vim
harness could ignore entirely.

| pinned | ttt side | why it would otherwise diverge |
| --- | --- | --- |
| `kill-whole-line` nil | — | the highest-risk single option for `C-k`: when t, `C-k` at a line start also kills the newline |
| `next-line-add-newlines` nil | — | when t, `C-n` on the last line **appends a newline** — a motion key that mutates the buffer |
| `line-move-visual` nil | `wordWrap: false` | required for batch (gotcha 2); also pins `C-n`/`C-p` to *logical* lines, which is what ttt moves by |
| `track-eol` nil | — | when t, `C-n`/`C-p` from EOL stick to EOL instead of keeping a goal column; ttt has its own goal-column preservation |
| `mark-even-if-inactive` nil | — | Emacs defaults to t, letting `C-w`/`M-w` act on a *deactivated* mark; ttt has no such state (no selection ⇒ no region) |
| `transient-mark-mode` 1 | — | region activation ⇔ ttt selection; also what makes the mark observable on the ttt side |
| `electric-indent-mode` 0 | `autoIndent: false` | a **global** minor mode, on by default; it would reindent on `C-o` / `RET` |
| `indent-tabs-mode` nil | `insertSpaces: true` | |
| `tab-width` 4 | `tabSize: 4` | |
| `require-final-newline` nil | `insertFinalNewline: true` | both inert — nothing is saved — pinned so a future save-based case starts from a known model |
| `kill-ring-max` 60 | — | only observable once `M-y` lands; pinned now so it never becomes the surprise |
| `case-fold-search` t | — | the base for isearch's smart case: a lower-case search string folds case, one upper-case character in it does not |
| `search-upper-case` `not-yanks` | — | the default, and what enables the smart-case rule at all — nil would make every search fold case |
| `search-nonincremental-instead` nil | — | `RET` on an **empty** isearch string otherwise starts a *nonincremental* search, which prompts in the minibuffer; in batch that swallows the rest of the macro as input and **hangs** the oracle. ttt-emacs has no nonincremental search |
| — | `showTrailingNewline: false` | gotcha 7: the buffer-model pin, and the reason ttt-vim's phantom-line problem does not exist here |

### Word boundaries: the major mode *is* a parity setting

`(fundamental-mode)` is pinned in `parity.js`, not buried in the oracle, because
it selects the **`standard-syntax-table`** — and the syntax table is what decides
where `M-f`, `M-b`, `M-d`, `M-u`, `M-l` and `M-c` stop. Under
`standard-syntax-table`, letters and digits are word constituents while `_`, `-`
and `.` are **not**, so `M-f` on `foo_bar` stops after `foo`, and on
`path/to/file.txt` it stops at every `/` and `.`.

**ttt-emacs's character classes must match `standard-syntax-table`.** This is
where word-motion divergences will come from, and the corpus is stocked with
underscores, dots, slashes and digits precisely to hit them.

### Known parity hazards

Behaviours worth encoding here rather than rediscovering as "bugs":

- **Consecutive kills append into ONE kill-ring entry.** Emacs chains them via
  `last-command`, so `C-k C-k C-k` then `C-y` yanks all three killed regions
  back as a single block — it does not yank only the last one. The same holds
  for consecutive `M-d`. Any fuzz sequence with two adjacent kills exercises
  this, and `generator.js` deliberately emits repeated kills ~30% of the time.
  Verified on the oracle: `C-k C-k C-k M-> C-y` on
  `"alpha beta gamma\ndelta beta epsilon\nlast"` yanks
  `"alpha beta gamma\ndelta beta epsilon"` back at point-max. Note this is
  exactly the property gotcha 5 protects — run the tokens one macro at a time
  and the chaining silently disappears.
- **`C-y` leaves point at the END of the yanked text, with the mark at its
  beginning.** So a yank is one of the few commands that makes the mark
  observable without an explicit `C-SPC`, and getting it backwards shows up as a
  `point` divergence, not a `text` one.
- **`M->` and `M-<` push the mark** at the previous position. Cheap to get wrong,
  invisible to a text-only comparison.

## Command alphabet — v1

The safe, high-value core. Every entry in `alphabet.js` is tagged with the
Emacs command it exercises.

- **Movement:** `C-f C-b C-n C-p C-a C-e M-f M-b M-< M->`
- **Kill / yank:** `C-k C-y C-w M-w C-d DEL M-d`
- **Mark:** `C-SPC C-x C-x`
- **Case:** `M-u M-l M-c`
- **Other:** `C-t C-o C-/`
- **Search:** `C-s <chars> RET`, `C-r <chars> RET`, each optionally with a
  repeat or a change of direction before the terminator — as **compound**
  tokens (see "The token model"), never as a loose `C-s`
- **Self-insert:** printable ASCII, including a literal space

`SEARCH_STRINGS` in `alphabet.js` is half hits and half misses against
`corpus.js` on purpose: a miss is not a dud, it exercises the *failing* state,
and a `C-s` after it exercises **wrapping**. Mixed-case strings exercise smart
case.

### Widening the alphabet

`alphabet.js` has an explicit `DEFERRED` array — **add new keys there first**,
with the reason they are blocked.

Isearch was the first entry to come off that list, and it is the worked example
for anything else interactive (`M-%` next). What it took:

1. a **compound token** in `keys.js` (`parseCompound`) so the whole
   search-and-terminate sequence is one indivisible unit on both sides;
2. `tokenCommandCount`, because a compound is several commands and the oracle's
   error-resume arithmetic assumed one;
3. two parity pins (`search-nonincremental-instead`, `search-upper-case`) —
   the first of which *hangs* the oracle when it is missed;
4. a generator action that emits the compound, and fixed cases in
   `differential.test.js`.

Still deferred:
- **`M-%` (query-replace)** — interactive in the same way isearch was, and not
  implemented in the plugin yet. Same recipe as above.
- **`C-g`** — signals `quit`, not `error`; the oracle already catches it, but
  there is no stated property for "state after a quit mid-command" until prefix
  args land. (isearch's own `C-g` *is* covered — inside a compound it is just
  another key, and `tests/emacs-isearch.test.js` pins both of its stages.)
- **`C-u`** — spans tokens, breaking one-token-one-command. Emit `C-u 3 C-f` as
  a single compound token when it lands.
- **`C-x C-s`** — would prompt for a filename in the oracle (the buffer has no
  `buffer-file-name`) and hang the batch process. Never fuzzable here.
- **`RET` / `TAB`** — safe keys, but their result depends on indentation
  behaviour that `parity.js` only pins nominally; add them with an indent parity
  pass.

Also deferred, in rough priority order: registers (`C-x r`), rectangles,
keyboard macros (`C-x (` … `C-x e`), `M-t` / `M-;`, sexp motion (`C-M-f`), and
a UTF-8 corpus (a high-value differential target given ttt's explicit rune
handling, but Emacs column semantics need their own parity work first).

## Input corpus

`corpus.js` exports `CORPUS` (20 lines: brackets, quotes, underscores, digits,
indentation, a blank line, mixed case, repeated words) and `SMALL` (5 lines, for
hand-written cases and readable shrink diffs). Both are ASCII and **neither ends
in a newline** (gotcha 7).

## Failure handling

- `fuzz.mjs` writes `reports/report-<seed>.json` with `{ seed, keys, tokens,
  reasons, emacs, ttt, diff }` — reproducible from the seed alone.
- `shrink.mjs` delta-debugs a failing sequence down to a minimal subsequence,
  preserving the *divergence reason* (a `point`-only divergence will not be
  shrunk into a `text`-only one), then prints a 3-run stability check.
- `repro.mjs` runs one seed or one explicit token array and prints the diff.
- Promote each triaged, minimized divergence into `differential.test.js`: into
  `CASES` if ttt-emacs should match, into `KNOWN_DIVERGENCES` if the gap is
  accepted for now (that block asserts the sides still *differ*, so the test
  flips loudly when someone fixes it).

## Phasing

1. **Harness skeleton + model parity** — fixed sequences through both sides
   (`differential.test.js`), confirming identical `{text, point, mark}` on
   known-good cases. Proves the plumbing and `parity.js` before any fuzzing.
2. **Generator over the v1 alphabet** — a batch of seeds, triage the first
   divergences.
3. **Shrinking + reporter polish**, findings written up.
4. **Widen the alphabet.** isearch landed here, as a compound token — see
   "Widening the alphabet" for the four things it took. Next: query-replace,
   prefix args, registers, macros, then a UTF-8 corpus.

Prereqs: `emacs` on PATH (verified against **GNU Emacs 27.1**; set `EMACS_BIN`
to override) and a built ttt binary (`npm run prepare-ttt`, or `TTT_BIN`).
