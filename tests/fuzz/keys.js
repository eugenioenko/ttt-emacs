// Token → keystroke translation for both sides.
//
// A "token" is a single string. Either:
//   - a NAMED key: the canonical Emacs key description of one complete key
//     sequence — "C-a", "M-f", "C-SPC", "C-x C-x", "DEL", "RET".
//   - a literal self-inserting character: exactly one printable ASCII char
//     (0x20–0x7e) — "a", "(", '"', " ".
//
// One token == one Emacs *command*. That invariant is what lets the oracle
// resume after a token that signals a Lisp error (see emacs-oracle.js), and it
// is why multi-key sequences like "C-x C-x" are a single token rather than two.
//
// The Emacs side wants `kbd` descriptions; the ttt side wants `--exec` steps,
// where runs of literal printables coalesce into one `type`.

// Named tokens and how each side encodes them. The key of the table IS the
// canonical token, and (by construction) also the Emacs kbd description — the
// table exists to carry the ttt spelling and to whitelist what is nameable.
const NAMED = {
  // --- movement ---
  "C-f": { ttt: "ctrl+f" },
  "C-b": { ttt: "ctrl+b" },
  "C-n": { ttt: "ctrl+n" },
  "C-p": { ttt: "ctrl+p" },
  "C-a": { ttt: "ctrl+a" },
  "C-e": { ttt: "ctrl+e" },
  "M-f": { ttt: "alt+f" },
  "M-b": { ttt: "alt+b" },
  "M-<": { ttt: "alt+<" },
  "M->": { ttt: "alt+>" },

  // --- kill / yank ---
  "C-k": { ttt: "ctrl+k" },
  "C-y": { ttt: "ctrl+y" },
  "C-w": { ttt: "ctrl+w" },
  "M-w": { ttt: "alt+w" },
  "C-d": { ttt: "ctrl+d" },
  DEL: { ttt: "backspace" },
  "M-d": { ttt: "alt+d" },

  // --- mark / region ---
  "C-SPC": { ttt: "ctrl+space" },
  "C-x C-x": { ttt: "ctrl+x ctrl+x" },

  // --- case ---
  "M-u": { ttt: "alt+u" },
  "M-l": { ttt: "alt+l" },
  "M-c": { ttt: "alt+c" },

  // --- other ---
  "C-t": { ttt: "ctrl+t" },
  "C-o": { ttt: "ctrl+o" },
  "C-/": { ttt: "ctrl+/" },
  RET: { ttt: "enter" },

  // --- translatable but NOT fuzzable (see alphabet.js DEFERRED) ---
  // C-g signals `quit` rather than `error` in batch; the oracle catches both,
  // but keyboard-quit's effect on a half-finished command is not a property we
  // can state yet. C-x C-s would prompt for a filename in the oracle (the
  // buffer has no file name) and hang it — never put it in the alphabet.
  "C-g": { ttt: "ctrl+g" },
  "C-s": { ttt: "ctrl+s" },
  "C-r": { ttt: "ctrl+r" },
  "M-%": { ttt: "alt+%" },
  "C-x C-s": { ttt: "ctrl+x ctrl+s" },
};

export function isNamed(tok) {
  return Object.prototype.hasOwnProperty.call(NAMED, tok);
}

// A literal token is exactly one printable ASCII character. Unlike the Vim
// harness, multi-char literal tokens are rejected: a token must be one command,
// and one self-insert is one command.
export function isLiteral(tok) {
  if (typeof tok !== "string" || tok.length !== 1) return false;
  const c = tok.charCodeAt(0);
  return c >= 0x20 && c <= 0x7e;
}

export function isToken(tok) {
  return isNamed(tok) || isLiteral(tok);
}

// --- Emacs side -------------------------------------------------------------

// `kbd` descriptions for the literal characters that are not their own name.
const LITERAL_KBD = { " ": "SPC" };

// One token → one `kbd` description string.
export function tokenToEmacsKbd(tok) {
  if (isNamed(tok)) return tok;
  if (isLiteral(tok)) return LITERAL_KBD[tok] || tok;
  throw new Error(`keys: untranslatable token for emacs: ${JSON.stringify(tok)}`);
}

// One `kbd` description PER TOKEN, not one joined string. The oracle needs the
// token boundaries so it can restart the macro after an erroring command;
// joining them with " " yields the single-macro form when that is wanted.
export function tokensToEmacsKbd(tokens) {
  return tokens.map(tokenToEmacsKbd);
}

// --- ttt side ---------------------------------------------------------------

// `--exec` steps. Consecutive literals become one `type <run>`; named keys
// become `key <combo>`.
//
// Two constraints come from the --exec parser (internal/app/exec_script.go):
//   - each step is TrimSpace'd, so a `type` run may never start or end with a
//     space; a literal space is emitted as `key space` instead.
//   - `type` args are stripQuotes'd, so a run that both starts and ends with a
//     double quote would silently lose them; such a run is split.
export function tokensToTttKeys(tokens) {
  const steps = [];
  let run = "";
  const flush = () => {
    if (!run) return;
    if (run.length >= 2 && run[0] === '"' && run[run.length - 1] === '"') {
      // Split so the step is never a fully quoted string.
      steps.push(`type ${run.slice(0, -1)}`);
      steps.push(`type ${run.slice(-1)}`);
    } else {
      steps.push(`type ${run}`);
    }
    run = "";
  };

  for (const t of tokens) {
    // Named keys first: a named token like "DEL" is all-printable and would
    // otherwise be mistaken for literal characters.
    if (isNamed(t)) {
      flush();
      steps.push(`key ${NAMED[t].ttt}`);
      continue;
    }
    if (isLiteral(t)) {
      if (t === " ") {
        flush();
        steps.push("key space");
        continue;
      }
      run += t;
      continue;
    }
    throw new Error(`keys: untranslatable token for ttt: ${JSON.stringify(t)}`);
  }
  flush();
  return steps;
}

// Human-readable rendering of a token stream, for reports.
export function describe(tokens) {
  return tokens.map((t) => (t === " " ? "SPC" : t)).join(" ");
}
