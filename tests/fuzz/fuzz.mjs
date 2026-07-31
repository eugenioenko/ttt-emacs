// Batch differential fuzzer (on-demand — like the ttt chaos monkey, not part of
// the default `npm test`). For each seed in a range it generates a token
// sequence, replays it through real Emacs and ttt-emacs, and compares
// {text, point, mark}. Divergences are written as reproducible reports.
//
//   node tests/fuzz/fuzz.mjs                 # seeds 1..200, 8 actions each
//   FUZZ_START=1 FUZZ_COUNT=500 node tests/fuzz/fuzz.mjs
//   FUZZ_ACTIONS=12 node tests/fuzz/fuzz.mjs
//   FUZZ_SEED=1337 node tests/fuzz/fuzz.mjs  # run a single seed (verbose)
//   FUZZ_MARK_MODE=strict node tests/fuzz/fuzz.mjs
//   FUZZ_SMALL=1 node tests/fuzz/fuzz.mjs    # 5-line corpus (readable diffs)
//
// Exit code is nonzero if any divergence is found, so it can gate CI.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generator.js";
import { runEmacs } from "./emacs-oracle.js";
import { runTtt } from "./ttt-runner.js";
import { compareStates, diffStates } from "./normalize.js";
import { describe as describeTokens } from "./keys.js";
import { CORPUS, SMALL } from "./corpus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(HERE, "reports");
const FIXTURE = process.env.FUZZ_SMALL ? SMALL : CORPUS;

const start = Number(process.env.FUZZ_START || 1);
const single = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : null;
const count = single ? 1 : Number(process.env.FUZZ_COUNT || 200);
const actions = Number(process.env.FUZZ_ACTIONS || 8);

function runSeed(seed) {
  const tokens = generate(seed, { actions });
  let emacs, ttt, error, cmp;
  try {
    emacs = runEmacs(FIXTURE, tokens);
    ttt = runTtt(FIXTURE, tokens);
    cmp = compareStates(emacs, ttt);
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  return { seed, tokens, emacs, ttt, error, cmp, diverged: !error && !cmp.equal };
}

function writeReport(r) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const file = join(REPORT_DIR, `report-${r.seed}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        seed: r.seed,
        keys: describeTokens(r.tokens),
        tokens: r.tokens,
        reasons: r.cmp ? r.cmp.reasons : null,
        error: r.error || null,
        emacs: r.emacs || null,
        ttt: r.ttt || null,
        diff: r.error ? null : diffStates(r.emacs, r.ttt),
      },
      null,
      2,
    ),
  );
  return file;
}

const seeds = single ? [single] : Array.from({ length: count }, (_, i) => start + i);
console.log(`fuzz: ${seeds.length} seed(s) [${seeds[0]}..${seeds[seeds.length - 1]}], ${actions} actions each`);

let diverged = 0;
let errored = 0;
for (const seed of seeds) {
  const r = runSeed(seed);
  if (r.error) {
    errored++;
    console.log(`  seed ${seed}: ERROR ${r.error} → ${writeReport(r)}`);
  } else if (r.diverged) {
    diverged++;
    console.log(`  seed ${seed}: DIVERGENCE [${r.cmp.reasons.join(", ")}] → ${writeReport(r)}`);
    if (single) {
      console.log(`  keys: ${describeTokens(r.tokens)}`);
      console.log(diffStates(r.emacs, r.ttt));
    }
  } else if (single) {
    console.log(`  seed ${seed}: match (${r.tokens.length} tokens)`);
    console.log(`  keys: ${describeTokens(r.tokens)}`);
  }
}

console.log(`fuzz: done — ${seeds.length - diverged - errored} matched, ${diverged} diverged, ${errored} errored`);
process.exit(diverged + errored > 0 ? 1 : 0);
