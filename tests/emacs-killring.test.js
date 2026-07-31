import { describe, it, expect, afterEach } from "vitest";
import { emacs, probe, cleanup } from "./emacs.js";

// The kill ring is a flat list, newest first, and the interesting part is the
// CHAINING: consecutive kills accumulate into one entry, backward kills prepend,
// and a kill that only signals does not extend the chain. Every test here reads
// the ring back through C-y, which is the only way to observe it.

afterEach(cleanup);

const TWO = "hello\nworld";
const WORDS = "alpha beta gamma";

describe("emacs kill ring: C-k", () => {
  it("kills to the end of the line but not the newline, even at column 1", () => {
    // kill-whole-line is nil, which is the Emacs default and the easiest thing
    // in the plugin to get backwards.
    const r = emacs(TWO, ["C-k"]);
    expect(r.text).toBe("\nworld");
    expect(r.point).toBe("1:1");
  });

  it("kills the newline at the end of a line, joining the next line on", () => {
    const r = emacs("one\ntwo", ["C-e", "C-k"]);
    expect(r.text).toBe("onetwo");
    expect(r.point).toBe("1:4");
  });

  it("kills the newline on an empty line", () => {
    // An empty line IS the end of the line, so C-k takes the newline.
    const r = emacs("\nworld", ["C-k"]);
    expect(r.text).toBe("world");
    expect(r.point).toBe("1:1");
  });

  it("signals at the end of the buffer and changes nothing", () => {
    const r = emacs("hello", ["M->", "C-k"]);
    expect(r.text).toBe("hello");
    expect(r.point).toBe("1:6");
    expect(r.status).toContain("End of buffer");
  });

  it("collects consecutive kills into ONE ring entry", () => {
    const r = emacs(TWO, ["C-k", "C-k", "M->", "C-y"]);
    expect(r.text).toBe("worldhello\n"); // "hello" and the newline, yanked back as one
    expect(r.point).toBe("2:1");
  });

  it("starts a new entry once a non-kill breaks the chain", () => {
    const r = emacs("one\ntwo\nthree", ["C-k", "C-n", "C-a", "C-k", "M->", "C-y"]);
    expect(r.text).toBe("\n\nthreetwo"); // only the second kill comes back
  });
});

describe("emacs kill ring: word kills", () => {
  it("kills the word after point with M-d", () => {
    const r = emacs(WORDS, ["M-d"]);
    expect(r.text).toBe(" beta gamma");
    expect(r.point).toBe("1:1");
  });

  it("chains consecutive M-d kills in buffer order", () => {
    const r = emacs(WORDS, ["M-d", "M-d", "M->", "C-y"]);
    expect(r.text).toBe(" gammaalpha beta");
  });

  it("does NOT signal at the end of the buffer — it kills the EMPTY region", () => {
    // Unlike C-k, which signals `end-of-buffer` itself before it ever calls
    // kill-region, kill-word is (kill-region (point) (progn (forward-word arg)
    // (point))) and forward-word merely returns nil at the buffer edge. So M-d
    // at point-max kills nothing, quietly. Verified against Emacs 27.1.
    const r = emacs("hello", ["M->", "M-d"]);
    expect(r.text).toBe("hello");
    expect(r.status).not.toContain("End of buffer");
  });

  it("kills the word before point with M-DEL", () => {
    const r = emacs("hello world", ["M->", "M-DEL"]);
    expect(r.text).toBe("hello ");
    expect(r.point).toBe("1:7");
  });

  it("PREPENDS chained backward kills so the entry reads in buffer order", () => {
    const r = emacs(WORDS, ["M-f M-f", "M-DEL", "M-DEL", "M->", "C-y"]);
    expect(r.text).toBe(" gammaalpha beta");
  });

  it("does NOT signal at the beginning of the buffer either", () => {
    const r = emacs("hello", ["M-DEL"]);
    expect(r.text).toBe("hello");
    expect(r.status).not.toContain("Beginning of buffer");
  });
});

describe("emacs kill ring: the EMPTY kill", () => {
  // `kill-new ""` is a real ring entry. Dropping empty kills instead would make
  // the NEXT C-y yank the previous entry — a whole line of text appearing from
  // nowhere — which is what these pin down. All four verified against Emacs 27.1
  // (tests/fuzz/differential.test.js runs the first two through the oracle).
  it("M-d at point-max pushes an empty entry, so a following C-y yanks nothing", () => {
    const r = emacs(TWO, ["C-k", "M->", "M-d", "C-y"]);
    expect(r.text).toBe("\nworld"); // NOT "\nworldhello"
  });

  it("M-w on an empty region pushes an empty entry", () => {
    const r = emacs(TWO, ["C-k", "M->", "C-SPC", "M-w", "C-y"]);
    expect(r.text).toBe("\nworld");
  });

  it("C-w on an empty region pushes an empty entry", () => {
    const r = emacs(TWO, ["C-k", "M->", "C-SPC", "C-w", "C-y"]);
    expect(r.text).toBe("\nworld");
  });

  it("an empty kill appended to a chain leaves the entry alone", () => {
    // M-DEL stores "beta"; the M-d that follows chains onto it and appends "",
    // so the entry is still "beta" and C-y yanks it back.
    const r = emacs("alpha beta", ["M->", "M-DEL", "M-d", "M-<", "C-y"]);
    expect(r.text).toBe("betaalpha ");
  });
});

describe("emacs kill ring: M-w does not start a chain", () => {
  it("leaves a following kill in its own entry", () => {
    // copy-region-as-kill never sets this-command to 'kill-region, so `M-w C-k`
    // makes two entries. Verified against Emacs 27.1.
    const r = emacs("one\ntwo", ["C-SPC", "C-e", "M-w", "C-k", "M->", "C-y"]);
    expect(r.text).toBe("onetwo\n"); // the newline alone, not "one" + newline
  });
});

describe("emacs kill ring: C-y and M-y", () => {
  it("yanks the most recent kill and leaves point after it", () => {
    const r = emacs(TWO, ["C-SPC", "M-f", "C-w", "M->", "C-y"]);
    expect(r.text).toBe("\nworldhello");
    expect(r.point).toBe("2:11");
  });

  it("yanks a prefix argument's worth of copies", () => {
    const r = emacs("one\ntwo", ["C-k", "M->", "C-u 2", "C-y"]);
    expect(r.text).toBe("\ntwooneone");
    expect(r.point).toBe("2:10");
  });

  it("signals on an empty kill ring and inserts nothing", () => {
    const r = emacs(WORDS, ["C-y"]);
    expect(r.text).toBe(WORDS);
    expect(r.status).toContain("Kill ring is empty");
  });

  it("cycles the ring with M-y, replacing what the yank inserted", () => {
    const r = emacs("alpha beta", ["M-d", "C-f", "M-d", "M->", "C-y", probe(), "M-y", probe(), "M-y"]);
    expect(r.probes[0].text).toBe(" beta"); // newest kill
    expect(r.probes[1].text).toBe(" alpha"); // one back
    expect(r.text).toBe(" beta"); // and round again
    expect(r.point).toBe("1:6");
  });

  it("refuses M-y when the previous command was not a yank", () => {
    const r = emacs(WORDS, ["M-d", "M->", "C-y", "C-f", "M-y"]);
    expect(r.status).toContain("Previous command was not a yank");
  });

  it("refuses M-y when the ring holds a single entry", () => {
    const r = emacs(WORDS, ["M-d", "M->", "C-y", "M-y"]);
    expect(r.text).toBe(" beta gammaalpha");
    expect(r.status).toContain("Kill ring has a single entry");
  });
});

describe("emacs kill ring: the empty-ring append quirk", () => {
  it("deletes the text and stores nothing when appending onto an empty ring", () => {
    // Reproduced on purpose. A REFUSED C-w still arms the kill chain — the
    // command loop sets this-command before the interactive spec signals — and
    // kill-append onto an empty ring signals only AFTER the text has been
    // deleted. So the line is gone and the ring is still empty.
    const r = emacs(TWO, ["C-w", "C-k", "M->", "C-y"]);
    expect(r.text).toBe("\nworld"); // "hello" was deleted
    expect(r.status).toContain("Kill ring is empty"); // but never stored
  });
});
