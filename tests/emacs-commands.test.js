import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { emacs, text, cleanup } from "./emacs.js";

// The file, buffer and help commands — the ones that bridge to ttt's own
// commands and overlays — plus the stubs. A stub must CONSUME its key and name
// itself in the echo area; falling through would type a stray character into the
// buffer, which is the failure these tests exist to catch.

afterEach(cleanup);

const FIXTURE = "alpha beta gamma\nsecond line here\nthird";

describe("emacs commands: files", () => {
  it("saves the buffer with C-x C-s", () => {
    const r = emacs(FIXTURE, [text("Z"), "C-x C-s"]);
    expect(readFileSync(r.file, "utf8")).toBe("Zalpha beta gamma\nsecond line here\nthird\n");
    expect(r.status).toContain("Wrote buffer.txt");
  });

  it("opens the quick-open overlay for C-x C-f and C-x b", () => {
    // find-file and switch-to-buffer are completing prompts that own the
    // keyboard in Emacs too, so handing the overlay the focus is correct here.
    // ttt has no buffer list distinct from its file list, so both land on the
    // same overlay.
    expect(emacs(FIXTURE, ["C-x C-f"]).overlay).not.toBeNull();
    expect(emacs(FIXTURE, ["C-x b"]).overlay).not.toBeNull();
  });

  it("closes the buffer with C-x k", () => {
    const r = emacs(FIXTURE, ["C-x k"]);
    expect(r.text).toBe("");
  });

  it("prompts before quitting a modified buffer with C-x C-c", () => {
    // Routed through editor.quit rather than ttt.quit() so unsaved work is not
    // silently discarded.
    const r = emacs(FIXTURE, [text("Z"), "C-x C-c"]);
    expect(r.overlay).not.toBeNull();
    expect(r.screen).toContain("Unsaved changes");
  });
});

describe("emacs commands: M-x and help", () => {
  it("opens the command palette for M-x", () => {
    const r = emacs(FIXTURE, ["M-x"]);
    expect(r.overlay).not.toBeNull();
    expect(r.text).toBe(FIXTURE);
  });

  it("describes the bindings for C-h b", () => {
    const r = emacs(FIXTURE, ["C-h b"]);
    expect(r.overlay).not.toBeNull();
    expect(r.screen).toContain("Emacs bindings");
    expect(r.screen).toContain("backward-char");
  });

  it("describes the bindings for C-h C-h too", () => {
    const r = emacs(FIXTURE, ["C-h C-h"]);
    expect(r.screen).toContain("Emacs bindings");
  });
});

describe("emacs commands: stubs", () => {
  // Each of these is deliberately unimplemented. They are bound anyway so the
  // key is consumed and the echo area explains itself, rather than the key
  // falling through to ttt (or, for a prefix, leaking its last character).
  // M-% and C-x C-w are wired to ttt dialogs (Replace, Save As) and are NOT
  // here. C-s / C-r are NOT here: isearch is implemented.
  const STUBS = [
    ["C-x r k", "kill-rectangle"],
    ["C-x r y", "yank-rectangle"],
    ["C-x r s", "copy-to-register"],
    ["C-x r j", "jump-to-register"],
  ];

  for (const [keys, name] of STUBS) {
    it(`${keys} is stubbed and names itself`, () => {
      const r = emacs(FIXTURE, [keys]);
      expect(r.text).toBe(FIXTURE);
      expect(r.point).toBe("1:1");
      expect(r.status).toContain(name);
      expect(r.status).toContain("not implemented yet");
    });
  }
});
