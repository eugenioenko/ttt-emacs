// Seeded token-sequence generator.
//
// Emacs is modeless, so there is no well-formedness constraint to satisfy: any
// token may follow any token. What a purely uniform stream would NOT produce
// often enough is the interesting *combinations* — a mark followed by a motion
// followed by a region command, a kill followed by a yank somewhere else, a
// burst of typing followed by an undo. So the generator composes small ACTIONS
// (each a short group of related tokens) rather than emitting bare keys.
//
// The token stream it returns is exactly what both runners replay.

import { makeRng, pick, int, chance } from "./rng.js";
import * as A from "./alphabet.js";

// A burst of 1–3 movement keys, biased towards the cheap char/line motions.
function movement(rng) {
  const n = int(rng, 1, 3);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.55) out.push(pick(rng, ["C-f", "C-b", "C-n", "C-p"]));
    else if (r < 0.8) out.push(pick(rng, ["M-f", "M-b"]));
    else if (r < 0.95) out.push(pick(rng, ["C-a", "C-e"]));
    else out.push(pick(rng, ["M-<", "M->"]));
  }
  return out;
}

// 1–5 self-inserting characters.
function typing(rng) {
  const n = int(rng, 1, 5);
  const out = [];
  for (let i = 0; i < n; i++) out.push(pick(rng, A.SELF_INSERT));
  return out;
}

// Set the mark, move somewhere, then act on the region. This is the action that
// makes the mark observable on BOTH sides (ttt only exposes it as a selection
// anchor — see normalize.js), so it is worth generating deliberately.
function regionAction(rng) {
  const tail = rng();
  const body = ["C-SPC", ...movement(rng)];
  if (tail < 0.35) return [...body, "C-w"]; // kill the region
  if (tail < 0.65) return [...body, "M-w"]; // copy the region
  if (tail < 0.85) return [...body, "C-x C-x"]; // swap and leave it active
  return body; // leave the region hanging — later commands must cope
}

// Kill something, then (usually) move and yank it back somewhere else.
function killYank(rng) {
  const k = pick(rng, ["C-k", "M-d", "C-d", "DEL"]);
  const reps = chance(rng, 0.3) ? int(rng, 2, 3) : 1;
  const out = [];
  for (let i = 0; i < reps; i++) out.push(k);
  if (chance(rng, 0.5)) out.push(...movement(rng), "C-y");
  return out;
}

// One complete incremental search, emitted as a single COMPOUND token (see
// keys.js `parseCompound`): a loose `C-s` would leave both editors mid-search,
// but a search carrying its own terminator is deterministic. The optional third
// key repeats or turns the search around before it ends, which is where the
// interesting semantics live — wrapping after a failure, and landing on the
// other end of the same match after a direction change.
function isearch(rng) {
  const dir = chance(rng, 0.35) ? "C-r" : "C-s";
  const parts = [dir, pick(rng, A.SEARCH_STRINGS)];
  if (chance(rng, 0.35)) {
    parts.push(chance(rng, 0.6) ? dir : dir === "C-s" ? "C-r" : "C-s");
  }
  parts.push("RET");
  return [parts.join(" ")];
}

// One complete action.
function action(rng) {
  const r = rng();

  // 28%: bare movement burst (positions point for whatever comes next)
  if (r < 0.28) return movement(rng);

  // 19%: kill / yank
  if (r < 0.47) return killYank(rng);

  // 13%: mark + region command
  if (r < 0.6) return regionAction(rng);

  // 12%: type some text
  if (r < 0.72) return typing(rng);

  // 9%: case transform, sometimes repeated across consecutive words
  if (r < 0.81) {
    const c = pick(rng, A.keys(A.CASE));
    return chance(rng, 0.4) ? [c, c] : [c];
  }

  // 7%: transpose / open-line
  if (r < 0.88) return [pick(rng, ["C-t", "C-o"])];

  // 7%: an incremental search
  if (r < 0.95) return isearch(rng);

  // 5%: undo, sometimes chained (consecutive C-/ must keep walking back)
  return chance(rng, 0.4) ? ["C-/", "C-/"] : ["C-/"];
}

// Generate a token array for a seed. `actions` controls sequence length.
export function generate(seed, { actions = 8 } = {}) {
  const rng = makeRng(seed);
  const tokens = [];
  const n = int(rng, Math.max(1, actions - 2), actions + 2);
  for (let i = 0; i < n; i++) tokens.push(...action(rng));
  return tokens;
}
