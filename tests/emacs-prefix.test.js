import { describe, it, expect, afterEach } from "vitest";
import { emacs, text, probe, cleanup } from "./emacs.js";

// The dispatcher is a trie, not a mode machine: a keystroke either descends into
// a keymap, runs a command, self-inserts, or falls through to the editor. These
// tests cover the descend/undefined/cancel paths and the pending-prefix echo,
// which is the only thing on screen that says a prefix is in flight.

afterEach(cleanup);

const FIXTURE = "alpha beta gamma\nsecond line here\nthird";

describe("emacs prefix: C-x sequences", () => {
  it("runs the command a C-x sequence names", () => {
    const r = emacs(FIXTURE, ["C-x h"]);
    expect(r.region).toBe("1:1-3:6");
  });

  it("shows the pending prefix in the echo area", () => {
    const r = emacs(FIXTURE, ["C-x", probe(), "C-g"]);
    expect(r.probes[0].status).toContain("C-x-");
  });

  it("shows a nested prefix as the whole path", () => {
    const r = emacs(FIXTURE, ["C-x r", probe(), "C-g"]);
    expect(r.probes[0].status).toContain("C-x r-");
  });

  it("reports an undefined sequence and swallows the key", () => {
    const r = emacs(FIXTURE, ["C-x z"]);
    expect(r.text).toBe(FIXTURE); // the "z" did not reach the buffer
    expect(r.status).toContain("C-x z is undefined");
  });

  it("reports an undefined sequence under a nested prefix", () => {
    const r = emacs(FIXTURE, ["C-h z"]);
    expect(r.text).toBe(FIXTURE);
    expect(r.status).toContain("C-h z is undefined");
  });

  it("clears the pending prefix so the next key is read at the top level", () => {
    // C-g is not bound inside C-x, so it reports "C-x C-g is undefined" — but
    // like any unknown sequence it resets the trie, and typing works again.
    const r = emacs(FIXTURE, ["C-x", "C-g", text("z")]);
    expect(r.text).toBe("zalpha beta gamma\nsecond line here\nthird");
    expect(r.point).toBe("1:2");
  });

  it("keeps an unimplemented sequence from leaking its last key", () => {
    // C-x r is present as a keymap precisely so C-x r k does not type a "k".
    const r = emacs(FIXTURE, ["C-x r k"]);
    expect(r.text).toBe(FIXTURE);
    expect(r.status).toContain("kill-rectangle");
  });
});

describe("emacs prefix: C-g at the top level", () => {
  it("says Quit and deactivates the region", () => {
    const r = emacs(FIXTURE, ["C-SPC", "M-f", "C-g"]);
    expect(r.region).toBeNull();
    expect(r.status).toContain("Quit");
  });
});

describe("emacs prefix: self-insertion", () => {
  it("passes ordinary printable characters through to the editor", () => {
    const r = emacs(FIXTURE, [text("XY")]);
    expect(r.text).toBe("XYalpha beta gamma\nsecond line here\nthird");
    expect(r.point).toBe("1:3");
  });

  it("inserts characters that are also prefix continuations", () => {
    // "h" is C-x h's second key and "e" repeats a macro, but at the top level
    // with no prefix pending both are just characters.
    const r = emacs("", [text("he")]);
    expect(r.text).toBe("he");
    expect(r.point).toBe("1:3");
  });

  it("shows EMACS in the status bar when nothing is pending", () => {
    expect(emacs(FIXTURE, ["C-f"]).status).toContain("EMACS");
  });
});
