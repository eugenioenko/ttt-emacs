import { describe, it, expect, afterEach } from "vitest";
import { emacs, text, probe, cleanup } from "./emacs.js";

// C-u, C-u C-u, C-u {digits}, C-u - and M-{digit} / M--. Every command takes the
// argument, and a self-inserting key with a count inserts that many copies.

afterEach(cleanup);

const FIXTURE = "alpha beta gamma\nsecond line here\nthird";

describe("emacs universal argument: movement", () => {
  it("repeats a movement the given number of times", () => {
    expect(emacs(FIXTURE, ["C-u 3", "C-f"]).point).toBe("1:4");
    expect(emacs(FIXTURE, ["C-u 2", "M-f"]).point).toBe("1:11");
    expect(emacs(FIXTURE, ["C-u 2", "C-n"]).point).toBe("3:1");
  });

  it("defaults to 4 for a bare C-u", () => {
    expect(emacs(FIXTURE, ["C-u", "C-f"]).point).toBe("1:5");
  });

  it("multiplies by four for each further C-u", () => {
    expect(emacs("", ["C-u C-u", text("z")]).text).toBe("z".repeat(16));
  });

  it("reverses the direction with C-u -", () => {
    expect(emacs("hello world", ["M-f", "C-u -", "C-f"]).point).toBe("1:5");
  });

  it("takes the argument from M-{digit} as well", () => {
    expect(emacs(FIXTURE, ["M-3", "C-f"]).point).toBe("1:4");
  });

  it("shows the pending argument in the echo area", () => {
    const r = emacs(FIXTURE, ["C-u", probe(), "C-g"]);
    expect(r.probes[0].status).toContain("C-u 4");
    expect(r.status).toContain("Quit");
  });
});

describe("emacs universal argument: kills", () => {
  it("kills whole lines with C-u N C-k", () => {
    const r = emacs("one\ntwo\nthree\nfour", ["C-u 2", "C-k"]);
    expect(r.text).toBe("three\nfour");
    expect(r.point).toBe("1:1");
  });

  it("kills back to the line start with C-u 0 C-k", () => {
    const r = emacs("hello world", ["M-f", "C-u 0", "C-k"]);
    expect(r.text).toBe(" world");
    expect(r.point).toBe("1:1");
  });

  it("kills several words with C-u N M-d", () => {
    const r = emacs(FIXTURE, ["C-u 2", "M-d"]);
    expect(r.text).toBe(" gamma\nsecond line here\nthird");
  });
});

describe("emacs universal argument: self-insert", () => {
  it("inserts N copies of the character", () => {
    const r = emacs(FIXTURE, ["C-u 3", text("z")]);
    expect(r.text).toBe("zzzalpha beta gamma\nsecond line here\nthird");
    expect(r.point).toBe("1:4");
  });

  it("inserts N copies for M-{digit} too", () => {
    const r = emacs(FIXTURE, ["M-3", text("z")]);
    expect(r.text).toBe("zzzalpha beta gamma\nsecond line here\nthird");
    expect(r.point).toBe("1:4");
  });

  it("does not leak the count into the next command", () => {
    const r = emacs(FIXTURE, ["C-u 3", "C-f", "C-f"]);
    expect(r.point).toBe("1:5");
  });
});
