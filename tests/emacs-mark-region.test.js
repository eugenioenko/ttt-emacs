import { describe, it, expect, afterEach } from "vitest";
import { emacs, text, cleanup } from "./emacs.js";

// The region is drawn with ttt's own selection, so `region` in these assertions
// is the highlighted range, written "startLine:startCol-endLine:endCol". It is
// non-null exactly when Emacs would call the region active.

afterEach(cleanup);

const FIXTURE = "alpha beta gamma\nsecond line here\nthird";
const HELLO = "hello world";

describe("emacs mark: setting and exchanging", () => {
  it("sets the mark with C-SPC and says so", () => {
    const r = emacs(HELLO, ["C-SPC"]);
    expect(r.status).toContain("Mark set");
    expect(r.region).toBe("1:1-1:1");
  });

  it("grows the region as point moves", () => {
    expect(emacs(HELLO, ["C-SPC", "M-f"]).region).toBe("1:1-1:6");
    expect(emacs(FIXTURE, ["C-SPC", "C-n"]).region).toBe("1:1-2:1");
  });

  it("exchanges point and mark with C-x C-x", () => {
    const r = emacs(HELLO, ["C-SPC", "M-f", "C-x C-x"]);
    expect(r.point).toBe("1:1");
    expect(r.region).toBe("1:1-1:6");
  });

  it("ACTIVATES the region on C-x C-x, whatever it was before", () => {
    // Verified against Emacs 27.1 rather than read off exchange-point-and-mark's
    // `xor` clause, which reads as though an inactive mark should stay inactive.
    // Here the mark was pushed by M-> with no region live.
    const r = emacs(HELLO, ["M->", "C-x C-x"]);
    expect(r.point).toBe("1:1");
    expect(r.region).toBe("1:1-1:12");
  });

  it("refuses C-x C-x with no mark", () => {
    const r = emacs(HELLO, ["C-x C-x"]);
    expect(r.point).toBe("1:1");
    expect(r.status).toContain("No mark set in this buffer");
  });

  it("marks the whole buffer with C-x h", () => {
    const r = emacs(FIXTURE, ["C-x h"]);
    expect(r.point).toBe("1:1");
    expect(r.region).toBe("1:1-3:6");
  });

  it("pops the mark ring with C-u C-SPC", () => {
    const r = emacs("hello\nworld", ["M-f", "M->", "C-u C-SPC"]);
    expect(r.point).toBe("1:6"); // back where M-> pushed the mark
    expect(r.region).toBeNull();
  });
});

describe("emacs region: kill and save", () => {
  it("kills the region with C-w", () => {
    const r = emacs(HELLO, ["C-SPC", "M-f", "C-w"]);
    expect(r.text).toBe(" world");
    expect(r.point).toBe("1:1");
    expect(r.region).toBeNull();
  });

  it("saves the region with M-w without changing the buffer", () => {
    const r = emacs(HELLO, ["C-SPC", "M-f", "M-w"]);
    expect(r.text).toBe(HELLO);
    expect(r.region).toBeNull();
    expect(r.status).toContain("Saved");
  });

  it("kills the whole buffer after C-x h", () => {
    expect(emacs(FIXTURE, ["C-x h", "C-w"]).text).toBe("");
  });

  it("refuses C-w and M-w with no mark, as a no-op", () => {
    for (const key of ["C-w", "M-w"]) {
      const r = emacs(HELLO, [key]);
      expect(r.text).toBe(HELLO);
      expect(r.point).toBe("1:1");
      expect(r.status).toContain("The mark is not set now, so there is no region");
    }
  });

  it("refuses with a DIFFERENT message when the mark is set but inactive", () => {
    // No mark at all is not the same state as an inactive mark, and Emacs has
    // two messages for them.
    const r = emacs(HELLO, ["C-SPC", "C-f", "C-g", "M-w"]);
    expect(r.text).toBe(HELLO);
    expect(r.status).toContain("The mark is not active now");
  });
});

describe("emacs region: deletion", () => {
  it("DEL deletes an active region, with no kill-ring entry", () => {
    // delete-active-region defaults to t, so delete-backward-char with a live
    // region eats the whole region — and DELETES it rather than killing it.
    const r = emacs(HELLO, ["C-SPC", "M-f", "DEL"]);
    expect(r.text).toBe(" world");
    expect(r.point).toBe("1:1");

    const yanked = emacs(HELLO, ["C-SPC", "M-f", "DEL", "C-y"]);
    expect(yanked.text).toBe(" world");
    expect(yanked.status).toContain("Kill ring is empty");
  });

  it("C-d does NOT delete the region, only one character", () => {
    // C-d is delete-char, which has no delete-active-region case; only DEL and
    // <delete> (delete-forward-char) do.
    const r = emacs(HELLO, ["C-SPC", "M-f", "C-d"]);
    expect(r.text).toBe("helloworld");
    expect(r.point).toBe("1:6");
  });

  it("DEL with an EMPTY active region deletes the character before point", () => {
    // `use-empty-active-region` is nil, so an empty region is not a region as far
    // as delete-backward-char is concerned: DEL behaves as if nothing were
    // marked, rather than deleting the (empty) region and so nothing at all.
    // Verified against Emacs 27.1; also asserted through the oracle in
    // tests/fuzz/differential.test.js.
    const r = emacs(HELLO, ["C-f", "C-SPC", "DEL"]);
    expect(r.text).toBe("ello world");
    expect(r.point).toBe("1:1");
  });

  it("DEL with an empty region at point-min still signals", () => {
    const r = emacs(HELLO, ["C-SPC", "DEL"]);
    expect(r.text).toBe(HELLO);
    expect(r.status).toContain("Beginning of buffer");
  });

  it("typing with a live region inserts at point instead of replacing it", () => {
    // The plugin deactivates the mark before a self-inserting key falls through,
    // which is what keeps ttt from replacing the selection.
    const r = emacs(HELLO, ["C-SPC", "M-f", text("z")]);
    expect(r.text).toBe("helloz world");
    expect(r.point).toBe("1:7");
  });
});

describe("emacs region: commands that move the mark", () => {
  it("M-> pushes the mark only when the region is INACTIVE", () => {
    // (or (consp arg) (region-active-p) (push-mark)) — pushing unconditionally
    // would move the mark out from under a live region.
    const pushed = emacs("hello\nworld", ["M-f", "M->", "C-u C-SPC"]);
    expect(pushed.point).toBe("1:6");

    const kept = emacs("hello\nworld", ["C-SPC", "M-f", "M->", "C-w"]);
    expect(kept.text).toBe(""); // the mark stayed at point-min, so C-w took it all
  });

  it("C-y pushes the mark BEFORE it can fail", () => {
    // yank runs (push-mark) ahead of (current-kill), so C-y C-x C-x is a working
    // pair on a fresh buffer even though the yank signalled.
    const r = emacs(FIXTURE, ["M-f", "C-y", "C-x C-x"]);
    expect(r.text).toBe(FIXTURE);
    expect(r.point).toBe("1:6");
    expect(r.region).toBe("1:6-1:6");
  });

  it("leaves the mark at the START of what C-y inserted", () => {
    const r = emacs(HELLO, ["C-SPC", "M-f", "M-w", "M->", "C-y", "C-x C-x"]);
    expect(r.text).toBe("hello worldhello");
    expect(r.point).toBe("1:12");
    expect(r.region).toBe("1:12-1:17");
  });

  it("drags the selection anchor when the mark moves under a live region", () => {
    // Reachable through the push-mark inside C-y. Without this the highlight
    // keeps painting from where the mark used to be.
    const r = emacs(HELLO, ["C-SPC", "C-f", "C-y"]);
    expect(r.region).toBe("1:2-1:2");
    expect(r.status).toContain("Kill ring is empty");
  });

  it("keeps the region across a movement command that signalled", () => {
    // A command that signals changes nothing else: it does not deactivate the
    // region and does not extend the kill chain.
    const r = emacs("hello", ["C-SPC", "M-f", "M->", "C-k", "C-w"]);
    expect(r.text).toBe("");
  });
});
