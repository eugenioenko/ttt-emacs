// Canonical editing-model parity between ttt-emacs and real Emacs.
//
// THE single source of truth. Every option that could change the text, the
// point or the mark a command produces is pinned on BOTH sides here, so the two
// editors share one editing model. A mismatch here reads as a false divergence,
// not a bug — when a new command class enters the alphabet and needs an option
// pinned, pin it in this one place.
//
// This set is deliberately LARGER than the ttt-vim harness's. Two reasons:
// Emacs has more defaults that silently alter buffer content (see
// `next-line-add-newlines`), and — critically — we compare point and mark, not
// just saved file bytes, so every option that affects CURSOR position matters
// too. That whole category was invisible to the Vim harness.

// --- ttt side: an isolated settings.json written into TTT_CONFIG_DIR ---------
export const TTT_SETTINGS = {
  editor: {
    // THE critical one, and the reason ttt-vim's phantom-trailing-line problem
    // (its FINDINGS.md F1) does not exist here. ttt's loader drops a file's
    // final newline; with showTrailingNewline it then re-adds a navigable empty
    // last line. Emacs's buffer model is the plain separator model with no
    // phantom line, so this must be OFF for `buffer.text.join("\n")` to equal
    // `(buffer-string)`. Fixtures also carry no trailing newline (corpus.js).
    showTrailingNewline: false,

    autoIndent: false, // ⇔ (electric-indent-mode 0)
    autoDedent: false, // ⇔ no dedent on a closing bracket; Emacs has none here
    insertSpaces: true, // ⇔ (setq indent-tabs-mode nil)
    tabSize: 4, // ⇔ (setq tab-width 4)
    insertFinalNewline: true, // ⇔ (setq require-final-newline nil): both inert —
    // nothing is ever saved (state comes from the debug
    // dump), pinned only so a future save-based case
    // starts from a known model.
    trimTrailingWhitespace: false, // Emacs never trims
    wordWrap: false, // point ↔ (line, col) must not depend on wrapping
    lineNumbers: false, // no effect on state
    syntaxHighlight: false, // no effect on state; keeps the run cheap
    gitGutter: false, // no effect on state; avoids git subprocesses
  },
  // Async subsystems would fire PostEvent redraws mid-script and add
  // nondeterminism for no benefit — all off.
  lsp: { enabled: false },
  autocomplete: { enabled: false, autoSuggest: false, signatureHelp: false },
};

// --- ttt side: the keybindings overlay that frees the Emacs keys -------------
//
// ttt registers a *force key* for every command in config.ForceKeyCommands
// (internal/app/commands.go), and force keys are matched ABOVE the plugin key
// interceptor (internal/ui/root.go, HandleEvent), so those five keys never
// reach ttt-emacs at all: C-b, C-p, C-t, C-q and M-t. The fix needs no core
// change -- force keys are only registered for SINGLE-step bindings, so moving
// the command elsewhere frees the key.
//
// Function keys, not chords: with ttt-emacs loaded C-k is kill-line, so every
// `ctrl+k x` chord is unreachable. F5/F7/F8/F9 are unbound in both ttt and
// `emacs -Q`, and staying single-step keeps terminal.toggle a force key, which
// is the only way out of the integrated terminal once it consumes raw keys.
//
// This is the same overlay ttt-emacs documents in its README, so the fuzzer
// tests the configuration users are told to run.
export const TTT_KEYBINDINGS = {
  "command.palette": "f5",
  "terminal.fullscreen": "f7",
  "terminal.toggle": "f8",
  "sidebar.toggle": "f9",
  "editor.quit": "f4",
};

// --- Emacs side: forms evaluated in the oracle buffer before the fuzzed keys --
//
// Rendered into the generated script with their `why` as an elisp comment, so
// the script a failing run leaves behind explains itself. Kept in lockstep with
// TTT_SETTINGS above.
export const EMACS_SETUP = [
  // ---- batch-mode requirements (see DESIGN.md gotchas 2 and 3) ----
  {
    form: "(setq inhibit-message t)",
    why: "GOTCHA 3: keep echo-area output out of stdout",
  },
  {
    form: "(setq line-move-visual nil)",
    why: "GOTCHA 2: C-n/C-p signal end-of-buffer without real window geometry; also pins vertical motion to LOGICAL lines, which is what ttt moves by",
  },
  { form: "(setq-default line-move-visual nil)", why: "same, for buffers created later" },

  // ---- the major mode IS a parity setting ----
  {
    form: "(fundamental-mode)",
    why: "pins the SYNTAX TABLE to standard-syntax-table, which is what decides where M-f/M-b/M-d/M-u/M-l/M-c stop. ttt-emacs's character classes must match it — see DESIGN.md 'Word boundaries'",
  },

  // ---- mark / region ----
  {
    form: "(transient-mark-mode 1)",
    why: "region activation semantics ⇔ ttt selection; also what makes `mark` observable on the ttt side at all",
  },
  {
    form: "(setq mark-even-if-inactive nil)",
    why: "Emacs defaults this to t, which lets C-w/M-w act on a DEACTIVATED mark. ttt has no such state — no selection means no region — so pin it off and let both sides error alike",
  },

  // ---- commands in the v1 alphabet ----
  {
    form: "(setq kill-whole-line nil)",
    why: "highest-risk single option for C-k parity: when t, C-k at a line start also kills the newline",
  },
  {
    form: "(setq next-line-add-newlines nil)",
    why: "when t, C-n on the last line APPENDS a newline — a motion key that mutates the buffer. Must be off",
  },
  {
    form: "(setq track-eol nil)",
    why: "when t, C-n/C-p from end-of-line stick to end-of-line instead of keeping a goal column. ttt has its own goal-column preservation, so pin the goal-column behaviour",
  },
  {
    form: "(setq kill-ring-max 60)",
    why: "kill-ring depth; only observable once M-y (yank-pop) enters the alphabet, pinned now so it never becomes the surprise",
  },
  {
    form: "(electric-indent-mode 0)",
    why: "⇔ editor.autoIndent false — electric-indent is a GLOBAL minor mode and on by default; it would reindent on C-o / RET",
  },

  // ---- whitespace / indentation model ----
  { form: "(setq indent-tabs-mode nil)", why: "⇔ editor.insertSpaces true" },
  { form: "(setq tab-width 4)", why: "⇔ editor.tabSize 4" },
  { form: "(setq require-final-newline nil)", why: "⇔ editor.insertFinalNewline; both inert (nothing is saved)" },

  // ---- search ----
  {
    form: "(setq case-fold-search t)",
    why: "the base for isearch's smart case: a lower-case search string folds case, an upper-case character in it does not (isearch-no-upper-case-p). ttt-emacs implements exactly that rule",
  },
  {
    form: "(setq search-nonincremental-instead nil)",
    why: "RET on an EMPTY isearch string otherwise starts a NONINCREMENTAL search, which prompts in the minibuffer — in batch that swallows the rest of the macro as input and hangs the oracle. ttt-emacs has no nonincremental search: RET simply exits",
  },
  {
    form: "(setq search-upper-case 'not-yanks)",
    why: "the default; it is what enables the smart-case rule above at all (nil would make every search fold case)",
  },

  // ---- undo ----
  {
    form: "(buffer-enable-undo)",
    why: "C-/ needs an undo list to walk (see DESIGN.md gotcha 6 for why the fixture insertion is then dropped from it)",
  },
];

// Screen size for the ttt run. Fixed for determinism, and tall/wide enough that
// no corpus line wraps and no motion depends on the viewport.
export const TTT_SIZE = "160x50";
