import { describe, it, expect, afterEach } from "vitest";
import { emacs, text, cleanup } from "./emacs.js";

// Editing commands that are not kills: deletion, transpose, open-line, the case
// commands and quoted-insert. Kills live in emacs-killring.test.js.

afterEach(cleanup);

describe("emacs edits: deletion", () => {
  it("deletes the character after point with C-d", () => {
    const r = emacs("hello", ["C-f", "C-d"]);
    expect(r.text).toBe("hllo");
    expect(r.point).toBe("1:2");
  });

  it("joins lines with C-d at the end of a line", () => {
    const r = emacs("ab\ncd", ["C-e", "C-d"]);
    expect(r.text).toBe("abcd");
    expect(r.point).toBe("1:3");
  });

  it("signals rather than deleting at the end of the buffer", () => {
    const r = emacs("ab", ["M->", "C-d"]);
    expect(r.text).toBe("ab");
    expect(r.point).toBe("1:3");
    expect(r.status).toContain("End of buffer");
  });

  it("deletes the character before point with DEL", () => {
    const r = emacs("hello", ["C-f", "C-f", "DEL"]);
    expect(r.text).toBe("hllo");
    expect(r.point).toBe("1:2");
  });

  it("joins lines with DEL at the start of a line", () => {
    const r = emacs("ab\ncd", ["C-n", "DEL"]);
    expect(r.text).toBe("abcd");
    expect(r.point).toBe("1:3");
  });

  it("signals rather than deleting at the start of the buffer", () => {
    const r = emacs("ab", ["DEL"]);
    expect(r.text).toBe("ab");
    expect(r.point).toBe("1:1");
    expect(r.status).toContain("Beginning of buffer");
  });
});

describe("emacs edits: C-t transpose-chars", () => {
  it("swaps the characters around point and steps past them", () => {
    const r = emacs("abc", ["C-f", "C-t"]);
    expect(r.text).toBe("bac");
    expect(r.point).toBe("1:3");
  });

  it("transposes the two PRECEDING characters at the end of a line", () => {
    // transpose-chars steps back one character when (eolp) and only then swaps
    // the pair around point.
    const r = emacs("abc", ["C-e", "C-t"]);
    expect(r.text).toBe("acb");
    expect(r.point).toBe("1:4");
  });

  it("drags a character onto the previous line at the start of a line", () => {
    // The newline is one of the two characters being swapped, which the point
    // model gives for free.
    const r = emacs("ab\ncd", ["C-n", "C-t"]);
    expect(r.text).toBe("abc\nd");
    expect(r.point).toBe("2:1");
  });

  it("signals at the beginning of the buffer", () => {
    const r = emacs("abc", ["C-t"]);
    expect(r.text).toBe("abc");
    expect(r.point).toBe("1:1");
    expect(r.status).toContain("Beginning of buffer");
  });
});

describe("emacs edits: C-o open-line", () => {
  it("opens a line after point without moving point", () => {
    const r = emacs("abcd", ["C-f", "C-f", "C-o"]);
    expect(r.text).toBe("ab\ncd");
    expect(r.point).toBe("1:3");
  });

  it("opens a prefix argument's worth of lines", () => {
    const r = emacs("ab", ["C-e", "C-u 3", "C-o"]);
    expect(r.text).toBe("ab\n\n\n");
    expect(r.point).toBe("1:3");
  });
});

describe("emacs edits: case commands", () => {
  it("upcases to the end of the word and leaves point there", () => {
    const r = emacs("hello world", ["M-u"]);
    expect(r.text).toBe("HELLO world");
    expect(r.point).toBe("1:6");
  });

  it("downcases to the end of the word", () => {
    const r = emacs("HELLO world", ["M-l"]);
    expect(r.text).toBe("hello world");
    expect(r.point).toBe("1:6");
  });

  it("capitalizes the word", () => {
    const r = emacs("hello world", ["M-c"]);
    expect(r.text).toBe("Hello world");
    expect(r.point).toBe("1:6");
  });

  it("chains because point lands at the end of the word", () => {
    const r = emacs("hello world", ["M-u", "M-u"]);
    expect(r.text).toBe("HELLO WORLD");
    expect(r.point).toBe("1:12");
  });

  it("capitalizes a partial word when the range starts mid-word", () => {
    // "he|llo" -> "heLlo": capitalize-region capitalizes the first character of
    // every word in the range, and the partial word counts.
    const r = emacs("hello world", ["C-f", "C-f", "M-c"]);
    expect(r.text).toBe("heLlo world");
    expect(r.point).toBe("1:6");
  });

  it("capitalizes every word in a prefix argument's range", () => {
    const r = emacs("hello brave world", ["C-u 3", "M-c"]);
    expect(r.text).toBe("Hello Brave World");
    expect(r.point).toBe("1:18");
  });
});

describe("emacs edits: C-q quoted-insert", () => {
  it("inserts the next printable character literally", () => {
    const r = emacs("ab", ["C-q", text("z")]);
    expect(r.text).toBe("zab");
    expect(r.point).toBe("1:2");
  });

  it("inserts a newline for C-q RET", () => {
    const r = emacs("ab", ["C-q", "RET"]);
    expect(r.text).toBe("\nab");
    expect(r.point).toBe("2:1");
  });
});
