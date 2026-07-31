// Unit tests for the pure fuzzer pieces (RNG + generator + key translation +
// point arithmetic). These run as part of `npm test` — they don't spawn
// editors, they just prove determinism and that every generated token is
// translatable to both sides.

import { describe, it, expect } from "vitest";
import { makeRng } from "./rng.js";
import { generate } from "./generator.js";
import { tokensToEmacsKbd, tokensToTttKeys, isNamed, isLiteral, isToken } from "./keys.js";
import { lineColToPoint, pointToLineCol, compareStates } from "./normalize.js";
import * as A from "./alphabet.js";

describe("rng", () => {
  it("is deterministic for a seed", () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it("differs across seeds", () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });
});

describe("generator", () => {
  it("produces identical token streams for the same seed", () => {
    for (const seed of [1, 2, 99, 1337]) {
      expect(generate(seed)).toEqual(generate(seed));
    }
  });

  it("respects the action count knob", () => {
    expect(generate(7, { actions: 30 }).length).toBeGreaterThan(generate(7, { actions: 3 }).length);
  });

  it("emits only tokens translatable to BOTH sides", () => {
    // If any token is neither named nor a single literal char, translation
    // throws — this is the guard that keeps the alphabet and the translators
    // in sync.
    for (let seed = 1; seed <= 200; seed++) {
      const tokens = generate(seed, { actions: 12 });
      for (const t of tokens) {
        expect(isToken(t), `untranslatable token ${JSON.stringify(t)} (seed ${seed})`).toBe(true);
      }
      expect(() => tokensToEmacsKbd(tokens)).not.toThrow();
      expect(() => tokensToTttKeys(tokens)).not.toThrow();
    }
  });

  it("never emits a deferred (interactive / hanging) key", () => {
    const blocked = new Set(A.DEFERRED.map((e) => e.key));
    for (let seed = 1; seed <= 200; seed++) {
      for (const t of generate(seed, { actions: 12 })) {
        expect(blocked.has(t), `deferred key ${t} leaked into seed ${seed}`).toBe(false);
      }
    }
  });
});

describe("key translation", () => {
  it("routes named keys to `key` steps, not literal text", () => {
    // Regression guard: "DEL" is all-printable characters; it must become the
    // backspace key on both sides, never the typed word "DEL".
    expect(tokensToTttKeys(["a", "DEL"])).toEqual(["type a", "key backspace"]);
    expect(tokensToEmacsKbd(["a", "DEL"])).toEqual(["a", "DEL"]);
  });

  it("keeps a multi-key sequence as one token", () => {
    expect(tokensToEmacsKbd(["C-x C-x"])).toEqual(["C-x C-x"]);
    expect(tokensToTttKeys(["C-x C-x"])).toEqual(["key ctrl+x ctrl+x"]);
  });

  it("coalesces literal runs into one ttt `type` step", () => {
    expect(tokensToTttKeys(["a", "b", "c"])).toEqual(["type abc"]);
  });

  it("emits a literal space as `key space`, never inside a `type` run", () => {
    // --exec TrimSpace's every step, so a leading/trailing space would vanish.
    expect(tokensToTttKeys(["a", " ", "b"])).toEqual(["type a", "key space", "type b"]);
    expect(tokensToEmacsKbd([" "])).toEqual(["SPC"]);
  });

  it("splits a run that would be stripped as a quoted string", () => {
    // --exec stripQuotes' a `type` arg that both starts and ends with `"`.
    expect(tokensToTttKeys(['"', "a", '"'])).toEqual(['type "a', 'type "']);
  });

  it("rejects multi-char literal tokens (one token must be one command)", () => {
    expect(isLiteral("ab")).toBe(false);
    expect(isNamed("C-f")).toBe(true);
    expect(() => tokensToEmacsKbd(["ab"])).toThrow();
  });
});

describe("point arithmetic", () => {
  const lines = ["alpha", "", "beta gamma"];

  it("maps (line, col) to a 1-based Emacs point", () => {
    expect(lineColToPoint(lines, 0, 0)).toBe(1); // point-min
    expect(lineColToPoint(lines, 0, 5)).toBe(6); // end of "alpha"
    expect(lineColToPoint(lines, 1, 0)).toBe(7); // the empty line
    expect(lineColToPoint(lines, 2, 0)).toBe(8); // start of "beta gamma"
    expect(lineColToPoint(lines, 2, 10)).toBe(18); // point-max
  });

  it("round-trips through pointToLineCol", () => {
    const text = lines.join("\n");
    for (let p = 1; p <= text.length + 1; p++) {
      const { line, col } = pointToLineCol(text, p);
      expect(lineColToPoint(lines, line, col)).toBe(p);
    }
  });
});

describe("state comparison", () => {
  const base = { text: "abc", point: 2, mark: 1, regionActive: true };

  it("compares text and point strictly", () => {
    expect(compareStates(base, { ...base, text: "abd" }).reasons).toContain("text");
    expect(compareStates(base, { ...base, point: 3 }).reasons).toContain("point");
  });

  it("compares the mark only when both regions are active (default mode)", () => {
    const inactive = { text: "abc", point: 2, mark: 1, regionActive: false };
    const inactiveOtherMark = { ...inactive, mark: 3 };
    expect(compareStates(inactive, inactiveOtherMark).equal).toBe(true);
    expect(compareStates(base, { ...base, mark: 3 }).reasons).toContain("mark");
  });

  it("compares the mark unconditionally in strict mode", () => {
    const inactive = { text: "abc", point: 2, mark: 1, regionActive: false };
    expect(compareStates(inactive, { ...inactive, mark: 3 }, { markMode: "strict" }).reasons).toContain("mark");
  });

  it("always compares region activation", () => {
    expect(compareStates(base, { ...base, regionActive: false }).reasons).toContain("regionActive");
  });
});
