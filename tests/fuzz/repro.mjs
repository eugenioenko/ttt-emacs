// Reproduce a single divergence. Runs one token sequence through both editors
// on the shared corpus and prints the state diff.
//
//   node tests/fuzz/repro.mjs 40                        # regenerate seed 40's tokens
//   node tests/fuzz/repro.mjs --tokens '["M-d","C-/"]'  # run an explicit token array
//   node tests/fuzz/repro.mjs 40 --actions 8            # match the batch's action count
//   node tests/fuzz/repro.mjs --tokens '["C-w"]' --small
//
// Use it to bisect a failing seed's tokens down to the minimal subsequence that
// still diverges (or let shrink.mjs do it for you).

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
  console.error("usage: repro.mjs <seed> | --tokens '[...]' [--actions N] [--small]");
  process.exit(2);
}

const FIXTURE = small ? SMALL : CORPUS;
const emacs = runEmacs(FIXTURE, tokens);
const ttt = runTtt(FIXTURE, tokens);
const cmp = compareStates(emacs, ttt);

console.log(`tokens (${tokens.length}): ${JSON.stringify(tokens)}`);
console.log(`keys: ${describeTokens(tokens)}`);
console.log(`emacs: ${summarize(emacs)}`);
console.log(`ttt:   ${summarize(ttt)}`);
if (emacs.errors.length) {
  console.log(`emacs errors: ${emacs.errors.map((e) => `${e.index}:${e.token}:${e.message}`).join(" | ")}`);
}
console.log(cmp.equal ? "RESULT: match" : `RESULT: DIVERGENCE [${cmp.reasons.join(", ")}]`);
if (!cmp.equal) {
  console.log("--- diff (- emacs / + ttt) ---");
  console.log(diffStates(emacs, ttt));
}
process.exit(cmp.equal ? 0 : 1);
