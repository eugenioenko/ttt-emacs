// The v1 fuzzer alphabet: the safe, high-value core of Emacs that ttt-emacs is
// expected to match exactly in {text, point, mark}. This is the coupling point
// between the fuzzer and the spec surface — grow it as coverage grows.
//
// Every entry is tagged with the Emacs command it exercises, so a divergence
// report names the thing that broke rather than a bare key.
//
// Emacs has no modes, so — unlike the Vim alphabet — there is no operator ×
// motion grammar to respect and no mode-balancing to do: any token is legal
// after any other token. The generator's job is only to make sequences
// *interesting*, not to make them well-formed.

// --- movement ---------------------------------------------------------------
export const MOVEMENT = [
  { key: "C-f", cmd: "forward-char", exercises: "char forward, line wrap at EOL" },
  { key: "C-b", cmd: "backward-char", exercises: "char backward, line wrap at BOL" },
  { key: "C-n", cmd: "next-line", exercises: "vertical motion + goal column" },
  { key: "C-p", cmd: "previous-line", exercises: "vertical motion + goal column" },
  { key: "C-a", cmd: "move-beginning-of-line", exercises: "BOL" },
  { key: "C-e", cmd: "move-end-of-line", exercises: "EOL" },
  { key: "M-f", cmd: "forward-word", exercises: "word boundaries (syntax table)" },
  { key: "M-b", cmd: "backward-word", exercises: "word boundaries (syntax table)" },
  { key: "M-<", cmd: "beginning-of-buffer", exercises: "point-min + push-mark" },
  { key: "M->", cmd: "end-of-buffer", exercises: "point-max + push-mark" },
];

// --- kill / yank ------------------------------------------------------------
export const KILL_YANK = [
  { key: "C-k", cmd: "kill-line", exercises: "kill to EOL, kill the newline when at EOL" },
  { key: "C-y", cmd: "yank", exercises: "kill ring head, mark set at yank start" },
  { key: "C-w", cmd: "kill-region", exercises: "region kill; errors with no mark" },
  { key: "M-w", cmd: "kill-ring-save", exercises: "region copy; errors with no mark" },
  { key: "C-d", cmd: "delete-char", exercises: "forward delete, joins lines at EOL" },
  { key: "DEL", cmd: "delete-backward-char", exercises: "backward delete, joins lines at BOL" },
  { key: "M-d", cmd: "kill-word", exercises: "word kill, appends to kill ring when consecutive" },
];

// --- mark / region ----------------------------------------------------------
export const MARK = [
  { key: "C-SPC", cmd: "set-mark-command", exercises: "mark set + region activation" },
  { key: "C-x C-x", cmd: "exchange-point-and-mark", exercises: "point/mark swap + reactivation" },
];

// --- case -------------------------------------------------------------------
export const CASE = [
  { key: "M-u", cmd: "upcase-word", exercises: "case transform + word motion" },
  { key: "M-l", cmd: "downcase-word", exercises: "case transform + word motion" },
  { key: "M-c", cmd: "capitalize-word", exercises: "case transform + word motion" },
];

// --- other ------------------------------------------------------------------
export const OTHER = [
  { key: "C-t", cmd: "transpose-chars", exercises: "char swap + the EOL special case" },
  { key: "C-o", cmd: "open-line", exercises: "newline insert that does NOT move point" },
  { key: "C-/", cmd: "undo", exercises: "undo grouping + consecutive-undo chaining" },
];

// --- incremental search (a COMPOUND unit, not a loose token) ----------------
//
// `C-s` on its own is not fuzzable: isearch reads keys until a terminator, so a
// loose `C-s` leaves both editors inside a search and everything after it means
// something different on each side. A search WITH its terminator is completely
// deterministic, which is why this enters the alphabet as a compound token —
// `C-s <chars> RET`, translated as one unit by keys.js (`parseCompound`).
//
// The strings are half hits and half misses against `corpus.js`: a miss is not
// a dud, it exercises the failing state, and a following `C-s` inside the same
// compound then exercises wrapping. Mixed-case strings exercise smart case
// (a lower-case string folds case; one upper-case character does not).
export const SEARCH_STRINGS = [
  // present in CORPUS and/or SMALL
  "the",
  "e",
  "a",
  "line",
  "foo",
  "beta",
  "two",
  "quick",
  "x",
  ")",
  "1",
  // present only with case folding
  "THE",
  "Foo",
  "mixedcase",
  // absent: the failing / wrapping path
  "zq",
  "qqq",
  "42x",
];

export const ISEARCH = [
  { key: "C-s … RET", cmd: "isearch-forward", exercises: "literal search, smart case, mark at the origin" },
  { key: "C-r … RET", cmd: "isearch-backward", exercises: "backward search, point at the match beginning" },
  { key: "C-s … C-s RET", cmd: "isearch-repeat-forward", exercises: "repeat, and wrapping when the search failed" },
  { key: "C-s … C-r RET", cmd: "isearch-repeat-backward", exercises: "changing direction mid-search" },
];

// Characters typed as self-insert-command. ASCII only for v1; includes the
// brackets/quotes/underscores that make word and syntax boundaries interesting.
// A literal space IS included (keys.js emits it as `key space`, never inside a
// `type` run, because --exec trims step arguments).
// Full ASCII printable set: lowercase, uppercase, digits, space, punctuation.
// The corpus is stocked with symbol-syntax chars (# $ % & @ < >) specifically
// to make word-boundary fuzzing interesting — M-f/M-b/M-d must stop at them.
export const SELF_INSERT = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?()[]{}\"'#_=+*/\\|@%&^~<>$`-"];

// --- DEFERRED — deliberately NOT in the fuzz alphabet yet -------------------
//
// ADD THEM HERE. Each needs work in the generator (and, for some, in the
// oracle) before it can be fuzzed; see DESIGN.md "Widening the alphabet".
//
//   - M-% (query-replace) is *interactive*: it reads keys until an explicit
//     terminator. Needs the compound-token recipe isearch established — a
//     generator action emitting the full prompt-and-terminate sequence — plus
//     a query-replace implementation to compare against. Plugin stub as of v1.
//   - C-g (keyboard-quit) is IMPLEMENTED in the plugin. The blocker now is
//     defining the stated property: after a standalone C-g the buffer, point
//     and mark are unchanged; region deactivates. After C-g mid-command the
//     oracle restarts at the next token (pre-command-hook counter). Add with
//     a property-checking differential wrapper.
//   - C-u (universal-argument) is IMPLEMENTED in the plugin. The blocker:
//     universal-arg spans tokens (C-u + digit + command), breaking the
//     one-token-one-command invariant. Emit "C-u 3 C-f" as a single compound
//     token. M-5 C-f (digit-argument) is the same class.
//   - C-x C-s (save-buffer) would prompt for a filename in the oracle buffer
//     (it has no buffer-file-name) and hang the batch process. Never fuzzable
//     in this harness.
//   - TAB / RET are safe keys but their result depends on indentation settings
//     that parity.js only pins nominally; add them together with an indent
//     parity pass.
export const DEFERRED = [
  { key: "M-%", cmd: "query-replace", blocked: "interactive; needs compound token + plugin implementation" },
  { key: "C-g", cmd: "keyboard-quit", blocked: "implemented in plugin; needs stated property + generator action" },
  { key: "C-u", cmd: "universal-argument", blocked: "implemented in plugin; needs compound token (spans tokens)" },
  { key: "C-x C-s", cmd: "save-buffer", blocked: "prompts in batch; would hang the oracle" },
  { key: "RET", cmd: "newline", blocked: "needs indent parity pass" },
  { key: "TAB", cmd: "indent", blocked: "needs indent parity pass" },
];

// --- helpers ----------------------------------------------------------------

export const keys = (group) => group.map((e) => e.key);

// Everything the generator may emit as a bare token.
export const ALL = [...keys(MOVEMENT), ...keys(KILL_YANK), ...keys(MARK), ...keys(CASE), ...keys(OTHER)];

// Lookup for reports: token → what it exercises. The ISEARCH entries are keyed
// by their SHAPE ("C-s … RET"), since the token itself carries a search string.
export const INFO = Object.fromEntries(
  [...MOVEMENT, ...KILL_YANK, ...MARK, ...CASE, ...OTHER, ...ISEARCH, ...DEFERRED].map((e) => [e.key, e]),
);
