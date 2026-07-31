// Phase 1 of the differential fuzzer (see DESIGN.md): NOT yet randomized.
//
// A hand-written set of fixed key sequences run through BOTH real Emacs (the
// oracle) and ttt-emacs, asserting identical {text, point, mark}. This proves
// the plumbing and — crucially — the model parity (parity.js) before any
// fuzzing is layered on. A failure here is either a parity bug in the harness
// or a genuine ttt-emacs divergence; both must be resolved before Phase 2.
//
// Requires a built ttt binary (`npm run prepare-ttt`) and `emacs` on PATH.

import { describe, it, expect } from "vitest";
import { runEmacs } from "./emacs-oracle.js";
import { runTtt } from "./ttt-runner.js";
import { compareStates, diffStates } from "./normalize.js";
import { describe as describeTokens } from "./keys.js";
import { SMALL } from "./corpus.js";

const FIXTURE = SMALL;

// Each case: a label and the token stream (see keys.js).
const CASES = [
  // --- movement (point-only properties the Vim harness could never assert) ---
  { name: "forward char (C-f)", tokens: ["C-f"] },
  { name: "char forward wraps at EOL (C-e C-f)", tokens: ["C-e", "C-f"] },
  { name: "char backward wraps at BOL (C-n C-b)", tokens: ["C-n", "C-b"] },
  { name: "word forward (M-f M-f)", tokens: ["M-f", "M-f"] },
  { name: "word backward from EOL (C-e M-b)", tokens: ["C-e", "M-b"] },
  { name: "goal column across a short line (C-e C-n C-n)", tokens: ["C-e", "C-n", "C-n"] },
  { name: "beginning/end of buffer (M-> M-<)", tokens: ["M->", "M-<"] },
  { name: "beginning of line on indented line (C-n C-n C-n C-n C-a)", tokens: ["C-n", "C-n", "C-n", "C-n", "C-a"] },

  // --- kill / yank ---
  { name: "kill line then yank on next line (C-a C-k C-n C-e C-y)", tokens: ["C-a", "C-k", "C-n", "C-e", "C-y"] },
  { name: "kill line twice at BOL (C-k C-k)", tokens: ["C-k", "C-k"] },
  // Consecutive kills APPEND into one kill-ring entry — see DESIGN.md
  // "Known parity hazards". Yanking only the last kill is the classic bug.
  { name: "consecutive kill-line appends to the kill ring (C-k C-k C-k M-> C-y)", tokens: ["C-k", "C-k", "C-k", "M->", "C-y"] },
  { name: "kill to EOL then kill the newline (C-e is a no-op) (M-f C-k C-k)", tokens: ["M-f", "C-k", "C-k"] },
  { name: "kill word (M-d)", tokens: ["M-d"] },
  { name: "consecutive kill-word appends to the kill ring (M-d M-d M-> C-y)", tokens: ["M-d", "M-d", "M->", "C-y"] },
  { name: "delete char joins lines at EOL (C-e C-d)", tokens: ["C-e", "C-d"] },
  { name: "backspace joins lines at BOL (C-n DEL)", tokens: ["C-n", "DEL"] },

  // --- mark / region ---
  { name: "mark + word + kill region (C-SPC M-f C-w)", tokens: ["C-SPC", "M-f", "C-w"] },
  { name: "mark + word + copy + yank at end (C-SPC M-f M-w M-> C-y)", tokens: ["C-SPC", "M-f", "M-w", "M->", "C-y"] },
  { name: "exchange point and mark (C-SPC M-f C-x C-x)", tokens: ["C-SPC", "M-f", "C-x C-x"] },
  { name: "multi-line region kill (C-SPC C-n C-n C-w)", tokens: ["C-SPC", "C-n", "C-n", "C-w"] },

  // --- case ---
  { name: "upcase word (M-u)", tokens: ["M-u"] },
  { name: "downcase word (C-n M-l)", tokens: ["C-n", "M-l"] },
  { name: "capitalize two words (M-c M-c)", tokens: ["M-c", "M-c"] },

  // --- other ---
  { name: "transpose chars (C-f C-t)", tokens: ["C-f", "C-t"] },
  { name: "open line does not move point (C-o)", tokens: ["C-o"] },
  { name: "self insert (x y z)", tokens: ["x", "y", "z"] },
  { name: "self insert with a space and a quote", tokens: ["x", " ", '"', "y"] },

  // --- undo ---
  // A run of self-inserts coalesces into one undo step, as in Emacs. Undo after
  // a *kill* does not — those cases are in KNOWN_DIVERGENCES below.
  { name: "typing then undo (a b c C-/)", tokens: ["a", "b", "c", "C-/"] },

  // --- error outcomes: the command signals, the buffer must be unchanged ---
  { name: "backward char at point-min errors and continues (C-b C-b x)", tokens: ["C-b", "C-b", "x"] },
  { name: "previous line at first line errors and continues (C-p M-d)", tokens: ["C-p", "M-d"] },
  { name: "kill region with no mark errors (C-w)", tokens: ["C-w"] },
  { name: "forward char past point-max errors (M-> C-f C-f)", tokens: ["M->", "C-f", "C-f"] },
];

// Divergences that are genuine but not yet fixed. These assert that ttt-emacs
// currently DIFFERS from Emacs, so the suite stays green while documenting the
// gap. When ttt-emacs is fixed, the assertion flips — move the case into CASES.
//
// Undo after a kill. `C-/` and `C-x u` delegate to editor.undo, whose undo-step
// boundaries are ttt's own. Emacs coalesces a run of self-inserts into one unit
// (which ttt matches — see CASES) and a run of kills into one, restoring point
// to the change site; undo after a kill is where the two disagree, in both text
// and point. Closing this means reimplementing Emacs's boundary rules against a
// stack the plugin does not own. See REFERENCE.md "Known gaps".
//
// Requires ttt >= the commit naming tcell.KeyNUL/KeyUS (PR #427); before that
// `C-/` never reached the plugin at all and every one of these differed for an
// unrelated reason.
const KNOWN_DIVERGENCES = [
  { name: "kill word then undo (M-d C-/)", tokens: ["M-d", "C-/"] },
  { name: "consecutive undo walks back (M-d M-d C-/ C-/)", tokens: ["M-d", "M-d", "C-/", "C-/"] },
];

function run(tokens) {
  const emacs = runEmacs(FIXTURE, tokens);
  const ttt = runTtt(FIXTURE, tokens);
  return { emacs, ttt, cmp: compareStates(emacs, ttt) };
}

describe("differential: fixed sequences (Phase 1 parity)", () => {
  for (const c of CASES) {
    it(`${c.name} matches real Emacs`, () => {
      const { emacs, ttt, cmp } = run(c.tokens);
      if (!cmp.equal) {
        throw new Error(
          `Divergence for "${c.name}" in [${cmp.reasons.join(", ")}]\n` +
            `keys:   ${describeTokens(c.tokens)}\n` +
            `tokens: ${JSON.stringify(c.tokens)}\n` +
            `--- diff (- emacs / + ttt) ---\n${diffStates(emacs, ttt)}\n`,
        );
      }
      expect(cmp.equal).toBe(true);
    });
  }
});

describe.skipIf(KNOWN_DIVERGENCES.length === 0)("differential: known divergences", () => {
  for (const c of KNOWN_DIVERGENCES) {
    it(`${c.name} still differs from Emacs`, () => {
      const { cmp } = run(c.tokens);
      // If this ever becomes equal, ttt-emacs fixed the gap — promote to CASES.
      expect(cmp.equal).toBe(false);
    });
  }
});
