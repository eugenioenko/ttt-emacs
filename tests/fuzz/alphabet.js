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

// Characters typed as self-insert-command. ASCII only for v1; includes the
// brackets/quotes/underscores that make word and syntax boundaries interesting.
// A literal space IS included (keys.js emits it as `key space`, never inside a
// `type` run, because --exec trims step arguments).
export const SELF_INSERT = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789 .,;:!?()[]{}\"'-_=+*/"];

// --- DEFERRED — deliberately NOT in the fuzz alphabet yet -------------------
//
// ADD THEM HERE. Each needs work in the generator (and, for the first two, in
// the oracle) before it can be fuzzed; see DESIGN.md "Widening the alphabet".
//
//   - C-s / C-r (isearch) and M-% (query-replace) are *interactive*: they read
//     keys until an explicit terminator (RET / ESC / C-g). A generator that
//     emits them without a matching terminator leaves the oracle inside a
//     recursive read and the two sides diverge for reasons that say nothing
//     about correctness. They work fine in batch when driven as a COMPLETE
//     unit — verified: (kbd "C-s b e t a RET") lands point at 11 on
//     "alpha beta gamma\ndelta beta epsilon" — so the way in is a compound
//     generator action that emits the whole search-and-terminate sequence as
//     one indivisible group, not a loose token.
//   - C-g (keyboard-quit) signals `quit`, not `error`. The oracle already
//     catches it, but "what is the state after a quit mid-command" is not a
//     property we can state until prefix arguments and isearch are in.
//   - C-u (universal-argument) spans tokens: the prefix and the command it
//     modifies are one command from the command loop's point of view, which
//     breaks the one-token-one-command invariant the error-resume logic relies
//     on. Emit "C-u 3 C-f" as a single compound token when it lands.
//   - C-x C-s (save-buffer) would prompt for a filename in the oracle buffer
//     (it has no buffer-file-name) and hang the batch process. Never fuzzable
//     in this harness.
//   - TAB / RET are safe keys but their result depends on indentation settings
//     that parity.js only pins nominally; add them together with an indent
//     parity pass.
export const DEFERRED = [
  { key: "C-s", cmd: "isearch-forward", blocked: "interactive; needs a compound generator action" },
  { key: "C-r", cmd: "isearch-backward", blocked: "interactive; needs a compound generator action" },
  { key: "M-%", cmd: "query-replace", blocked: "interactive; needs a compound generator action" },
  { key: "C-g", cmd: "keyboard-quit", blocked: "quit signal; no stated property yet" },
  { key: "C-u", cmd: "universal-argument", blocked: "spans tokens; breaks 1 token = 1 command" },
  { key: "C-x C-s", cmd: "save-buffer", blocked: "prompts in batch; would hang the oracle" },
  { key: "RET", cmd: "newline", blocked: "needs indent parity" },
];

// --- helpers ----------------------------------------------------------------

export const keys = (group) => group.map((e) => e.key);

// Everything the generator may emit as a bare token.
export const ALL = [...keys(MOVEMENT), ...keys(KILL_YANK), ...keys(MARK), ...keys(CASE), ...keys(OTHER)];

// Lookup for reports: token → what it exercises.
export const INFO = Object.fromEntries(
  [...MOVEMENT, ...KILL_YANK, ...MARK, ...CASE, ...OTHER, ...DEFERRED].map((e) => [e.key, e]),
);
