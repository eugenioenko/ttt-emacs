import { describe, it, expect, afterEach } from "vitest";
import { emacs, text, probe, cleanup } from "./emacs.js";

// Undo delegates to editor.undo. What is worth pinning is the GRANULARITY: ttt
// coalesces a run of typed characters into one step (which matches Emacs's
// amalgamation of consecutive self-insert-commands) and each plugin command is
// bracketed in exactly one undo group (which matches Emacs's per-command undo
// boundary).

afterEach(cleanup);

const FIXTURE = "alpha beta gamma\nsecond line here\nthird";

describe("emacs undo: C-x u", () => {
  it("undoes a run of typed characters in one step", () => {
    const r = emacs(FIXTURE, [text("XYZ"), "C-x u"]);
    expect(r.text).toBe(FIXTURE);
    expect(r.status).toContain("Undo!");
  });

  it("undoes a kill as one step", () => {
    const r = emacs("hello\nworld", ["C-k", "C-x u"]);
    expect(r.text).toBe("hello\nworld");
  });

  it("undoes a region kill as one step", () => {
    const r = emacs("hello world", ["C-SPC", "M-f", "C-w", "C-x u"]);
    expect(r.text).toBe("hello world");
  });

  it("walks back one edit per C-x u", () => {
    const r = emacs(FIXTURE, [text("A"), "C-f", text("B"), "C-x u", probe(), "C-x u"]);
    expect(r.probes[0].text).toBe("Aalpha beta gamma\nsecond line here\nthird");
    expect(r.text).toBe(FIXTURE);
  });

  it("repeats with a prefix argument", () => {
    const r = emacs(FIXTURE, [text("A"), "C-f", text("B"), "C-u 2", "C-x u"]);
    expect(r.text).toBe(FIXTURE);
  });

  it("does not leave a region active", () => {
    // undo deactivates the mark, so C-x h C-x u does not leave the whole buffer
    // highlighted.
    const r = emacs(FIXTURE, ["C-x h", "C-x u"]);
    expect(r.region).toBeNull();

    const typed = emacs(FIXTURE, [text("Z"), "C-SPC", "C-f", "C-x u"]);
    expect(typed.text).toBe(FIXTURE);
    expect(typed.region).toBeNull();
  });
});

describe("emacs undo: C-/", () => {
  // Requires ttt >= the commit naming tcell.KeyNUL/KeyUS (PR #427). Before it,
  // comboToTcell encoded ctrl+space as KeyNUL and ctrl+/ as KeyUS, neither of
  // which had a tcell.KeyNames entry, so event_convert.go reported both as
  // key="unknown" and the plugin could not tell them apart — C-SPC won, and
  // this asserted "Mark set" with the text NOT undone.
  it("undoes a typed run, distinct from C-SPC", () => {
    const r = emacs(FIXTURE, [text("XYZ"), "C-/"]);
    expect(r.text).toBe(FIXTURE);
    expect(r.status).not.toContain("Mark set");
  });

  it("still sets the mark on C-SPC", () => {
    const r = emacs(FIXTURE, ["C-SPC"]);
    expect(r.text).toBe(FIXTURE);
    expect(r.status).toContain("Mark set");
  });
});
