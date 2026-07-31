import { describe, it, expect, afterEach } from "vitest";
import { emacs, text, probe, cleanup } from "./emacs.js";

// Exercise the real shipped plugin in the real binary. Every assertion names an
// exact buffer and an exact point, written "line:col" with both 1-based — the
// plugin's own coordinates, in which col 1 is the start of a line and col
// #line+1 is the end (point sits BETWEEN characters, as in Emacs).

afterEach(cleanup);

// Line 1 is 16 characters, so C-e lands on 1:17. "_" is symbol syntax and "%"
// is word syntax in the standard syntax table, which is what M-f/M-b use.
const FIXTURE = "alpha beta gamma\nsecond line here\nthird";
const SHORT = "one\ntwo";
const RAGGED = "abcdefghij\nxy\nabcdefghij";
const LONG = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

describe("emacs movement: characters", () => {
  it("moves one character with C-f and C-b", () => {
    expect(emacs(FIXTURE, ["C-f", "C-f"]).point).toBe("1:3");
    expect(emacs(FIXTURE, ["C-f", "C-f", "C-b"]).point).toBe("1:2");
  });

  it("crosses the line break with C-f and C-b", () => {
    expect(emacs(SHORT, ["C-e", "C-f"]).point).toBe("2:1");
    // C-b at column 1 wraps to the END of the previous line, not to its start.
    expect(emacs(SHORT, ["C-n", "C-b"]).point).toBe("1:4");
  });

  it("signals at the buffer edges without moving or growing the buffer", () => {
    const end = emacs(SHORT, ["M->", "C-f"]);
    expect(end.point).toBe("2:4");
    expect(end.text).toBe(SHORT);
    expect(end.status).toContain("End of buffer");

    const start = emacs(SHORT, ["C-b"]);
    expect(start.point).toBe("1:1");
    expect(start.text).toBe(SHORT);
    expect(start.status).toContain("Beginning of buffer");
  });

  it("moves with the arrow keys like C-f and C-b", () => {
    expect(emacs(FIXTURE, ["<down>", "<right>", "<right>"]).point).toBe("2:3");
    expect(emacs(FIXTURE, ["<right>", "<left>"]).point).toBe("1:1");
  });
});

describe("emacs movement: lines", () => {
  it("moves between lines with C-n and C-p", () => {
    expect(emacs(FIXTURE, ["C-n"]).point).toBe("2:1");
    expect(emacs(FIXTURE, ["C-n", "C-n", "C-p"]).point).toBe("2:1");
    expect(emacs(FIXTURE, ["<down>", "<up>"]).point).toBe("1:1");
  });

  it("moves to point-max, not nowhere, when C-n runs off the last line", () => {
    // line-move-1 moves as far as it can and THEN signals, so C-n on the last
    // line lands on point-max rather than staying put — and with
    // next-line-add-newlines nil it must not append a line either.
    const r = emacs(SHORT, ["C-n", "C-n"]);
    expect(r.point).toBe("2:4");
    expect(r.text).toBe(SHORT);
    expect(r.status).toContain("End of buffer");
  });

  it("moves to point-min when C-p runs off the first line", () => {
    const r = emacs(SHORT, ["C-e", "C-p", "C-p"]);
    expect(r.point).toBe("1:1");
    expect(r.text).toBe(SHORT);
    expect(r.status).toContain("Beginning of buffer");
  });

  it("keeps the goal column across a short line", () => {
    const r = emacs(RAGGED, ["C-u 8", "C-f", "C-n", probe(), "C-n"]);
    expect(r.probes[0].point).toBe("2:3"); // clamped to the end of "xy"
    expect(r.point).toBe("3:9"); // and back out at the goal column
  });

  it("resets the goal column when a self-inserting key breaks the run", () => {
    // temporary-goal-column is only read when last-command is next-line or
    // previous-line; anything else — including typing — restarts it.
    const r = emacs(RAGGED, ["C-u 8", "C-f", "C-n", text("Z"), "C-n"]);
    expect(r.text).toBe("abcdefghij\nxyZ\nabcdefghij");
    expect(r.point).toBe("3:4");
  });
});

describe("emacs movement: line ends", () => {
  it("moves to the line ends with C-a and C-e", () => {
    expect(emacs(FIXTURE, ["C-e"]).point).toBe("1:17");
    expect(emacs(FIXTURE, ["M-f", "C-a"]).point).toBe("1:1");
    expect(emacs(FIXTURE, ["C-n", "C-e"]).point).toBe("2:17");
  });

  it("moves to the line ends with Home and End", () => {
    expect(emacs("  indented", ["<end>"]).point).toBe("1:11");
    // C-a is move-beginning-of-line, not back-to-indentation: it ignores indent.
    expect(emacs("  indented", ["<end>", "<home>"]).point).toBe("1:1");
  });
});

describe("emacs movement: words", () => {
  it("moves forward and backward by word with M-f and M-b", () => {
    expect(emacs(FIXTURE, ["M-f"]).point).toBe("1:6");
    expect(emacs(FIXTURE, ["M-f", "M-f"]).point).toBe("1:11");
    expect(emacs(FIXTURE, ["M-f", "M-f", "M-b"]).point).toBe("1:7");
    expect(emacs(FIXTURE, ["M->", "M-b"]).point).toBe("3:1");
  });

  it("uses Emacs word syntax, not Vim's", () => {
    // "$" and "%" are word constituents in standard-syntax-table; "_" is symbol
    // syntax and therefore a word BOUNDARY. Vim has both backwards.
    expect(emacs("a$b _c 50% d", ["M-f"]).point).toBe("1:4");
    expect(emacs("foo_bar baz", ["M-f"]).point).toBe("1:4");
    expect(emacs("foo_bar baz", ["M-f", "M-f"]).point).toBe("1:8");
  });
});

describe("emacs movement: buffer ends", () => {
  it("jumps to the buffer ends with M-< and M->", () => {
    expect(emacs(FIXTURE, ["M->"]).point).toBe("3:6");
    expect(emacs(FIXTURE, ["M->", "M-<"]).point).toBe("1:1");
  });
});

describe("emacs movement: scrolling", () => {
  it("scrolls a screenful with C-v and back with M-v", () => {
    const down = emacs(LONG, ["C-v"]);
    expect(down.point).toBe("33:1"); // a 34-line viewport, less the two-line overlap
    expect(down.top).toBe(33);
    expect(emacs(LONG, ["C-v", "M-v"]).point).toBe("1:1");
  });

  it("scrolls with PgDn and PgUp too", () => {
    expect(emacs(LONG, ["<pgdn>"]).point).toBe("33:1");
    expect(emacs(LONG, ["<pgdn>", "<pgup>"]).point).toBe("1:1");
  });

  it("stays at point-min when M-v runs off the top", () => {
    const r = emacs(LONG, ["M-v"]);
    expect(r.point).toBe("1:1");
    expect(r.top).toBe(1);
  });

  it("centres the view on point with C-l", () => {
    const r = emacs(LONG, ["M->", "C-l"]);
    expect(r.point).toBe("200:9"); // point does not move
    expect(r.top).toBe(183); // 200 - 34/2
  });
});
