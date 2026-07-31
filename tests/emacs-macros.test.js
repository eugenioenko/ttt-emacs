import { describe, it, expect, afterEach } from "vitest";
import { emacs, text, probe, cleanup } from "./emacs.js";

// C-x ( / C-x ) / C-x e. Recording captures canonical TOKENS, and a replay feeds
// them back through the dispatcher — so a macro replays the keys the plugin owns
// plus typed text, and nothing else (see REFERENCE.md, "Known gaps").

afterEach(cleanup);

const FIXTURE = "alpha beta gamma\nsecond line here\nthird";

describe("emacs macros: record and replay", () => {
  it("records with C-x ( and replays with C-x e", () => {
    const r = emacs("one\ntwo\nthree", ["C-x (", text("- "), "C-a", "C-n", "C-x )", "C-x e"]);
    expect(r.text).toBe("- one\n- two\nthree");
    expect(r.point).toBe("3:1");
  });

  it("repeats with a bare e after C-x e", () => {
    const r = emacs("one\ntwo\nthree", ["C-x (", text("- "), "C-a", "C-n", "C-x )", "C-x e", "e"]);
    expect(r.text).toBe("- one\n- two\n- three");
  });

  it("replays a prefix argument's worth of times", () => {
    const r = emacs("abc", ["C-x (", "C-d", "C-x )", "C-u 2", "C-x e"]);
    expect(r.text).toBe(""); // one deletion while recording, two on replay
  });

  it("replays typed text", () => {
    const r = emacs("", ["C-x (", text("ab"), "C-x )", "C-x e", "C-x e"]);
    expect(r.text).toBe("ababab");
    expect(r.point).toBe("1:7");
  });

  it("replays kills, chaining them as the live keys would", () => {
    const r = emacs("one\ntwo\nthree\nfour", ["C-x (", "C-k", "C-k", "C-x )", "C-x e"]);
    expect(r.text).toBe("three\nfour");
    expect(r.point).toBe("1:1");
  });

  it("does not record the C-x of the closing C-x )", () => {
    // stop_macro pops the trailing "ctrl-x" that was recorded before the prefix
    // resolved; if it did not, the replay would leave a prefix pending.
    const r = emacs("abcd", ["C-x (", "C-d", "C-x )", "C-x e", probe(), "C-x e"]);
    expect(r.probes[0].text).toBe("cd");
    expect(r.text).toBe("d");
  });
});

describe("emacs macros: state and errors", () => {
  it("shows Def in the status bar while recording", () => {
    const r = emacs("one\ntwo", ["C-x (", probe(), text("x"), "C-x )"]);
    expect(r.probes[0].status).toContain("Def");
    expect(r.probes[0].status).toContain("Defining kbd macro...");
    expect(r.status).toContain("Keyboard macro defined");
  });

  it("refuses C-x ) when no macro is being recorded", () => {
    const r = emacs(FIXTURE, ["C-x )"]);
    expect(r.text).toBe(FIXTURE);
    expect(r.status).toContain("Not defining kbd macro");
  });

  it("refuses C-x e when no macro has been defined", () => {
    const r = emacs(FIXTURE, ["C-x e"]);
    expect(r.text).toBe(FIXTURE);
    expect(r.status).toContain("No kbd macro has been defined");
  });

  it("discards the recording on C-g", () => {
    const r = emacs("one\ntwo", ["C-x (", text("x"), "C-g", "C-x e"]);
    expect(r.text).toBe("xone\ntwo"); // the typing stands, the macro does not
    expect(r.status).toContain("No kbd macro has been defined");
  });
});
