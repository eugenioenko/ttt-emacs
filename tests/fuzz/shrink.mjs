// Delta-debugging shrinker: reduce a divergent token sequence to a minimal
// subsequence that still diverges, so a bug report is as small as possible.
//
//   node tests/fuzz/shrink.mjs 40                     # shrink seed 40
//   node tests/fuzz/shrink.mjs --tokens '[...]'       # shrink an explicit sequence
//   node tests/fuzz/shrink.mjs 40 --small             # shrink against the 5-line corpus
//
// Prints the minimal tokens, a 3-run stability check, and the state diff. Feed
// the result into a differential.test.js case.
//
// Shrinking preserves the DIVERGENCE REASON where it can: a run that diverges
// only in `point` will not be shrunk into one that diverges only in `text`, so
// the minimal repro still demonstrates the bug you started with.

import { generate } from "./generator.js";
import { runEmacs } from "./emacs-oracle.js";
import { runTtt } from "./ttt-runner.js";
import { compareStates, diffStates, summarize } from "./normalize.js";
import { describe as describeTokens } from "./keys.js";
import { CORPUS, SMALL } from "./corpus.js";

const args = process.argv.slice(2);
let tokens = null;
let actions = 8;
let small = Boolean(process.env.FUZZ_SMALL);

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tokens") tokens = JSON.parse(args[++i]);
  else if (args[i] === "--actions") actions = Number(args[++i]);
  else if (args[i] === "--small") small = true;
  else if (!args[i].startsWith("--")) tokens = tokens || { seed: Number(args[i]) };
}
if (tokens && typeof tokens === "object" && "seed" in tokens) {
  tokens = generate(tokens.seed, { actions });
}
if (!Array.isArray(tokens)) {
  console.error("usage: shrink.mjs <seed> | --tokens '[...]' [--actions N] [--small]");
  process.exit(2);
}

const FIXTURE = small ? SMALL : CORPUS;

function reasons(toks) {
  if (toks.length === 0) return null;
  try {
    const cmp = compareStates(runEmacs(FIXTURE, toks), runTtt(FIXTURE, toks));
    return cmp.equal ? null : cmp.reasons;
  } catch {
    return null;
  }
}

const target = reasons(tokens);
if (!target) {
  console.log("original does not diverge (flaky?)");
  process.exit(0);
}
console.log(`original diverges in [${target.join(", ")}] (${tokens.length} tokens)`);

// A candidate counts as a shrink only if it still shows the original reasons.
const stillDiverges = (toks) => {
  const r = reasons(toks);
  return r !== null && target.every((x) => r.includes(x));
};

let cur = tokens.slice();
let changed = true;
while (changed) {
  changed = false;
  for (let size = Math.min(cur.length, 8); size >= 1; size--) {
    for (let i = 0; i + size <= cur.length; i++) {
      const cand = cur.slice(0, i).concat(cur.slice(i + size));
      if (stillDiverges(cand)) {
        cur = cand;
        changed = true;
        i--; // stay at this index; the window shifted under us
      }
    }
  }
}

let divCount = 0;
for (let k = 0; k < 3; k++) if (stillDiverges(cur)) divCount++;

const emacs = runEmacs(FIXTURE, cur);
const ttt = runTtt(FIXTURE, cur);
console.log(`MINIMAL (${cur.length}): ${JSON.stringify(cur)}`);
console.log(`keys: ${describeTokens(cur)}`);
console.log(`stability: ${divCount}/3 diverge`);
console.log(`emacs: ${summarize(emacs)}`);
console.log(`ttt:   ${summarize(ttt)}`);
console.log("--- diff (- emacs / + ttt) ---");
console.log(diffStates(emacs, ttt));
