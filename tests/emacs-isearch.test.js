import { describe, it, expect, afterEach } from "vitest";
import { emacs, text, probe, cleanup } from "./emacs.js";

// Incremental search. Every expectation here was taken from GNU Emacs 27.1
// through the differential oracle (tests/fuzz/emacs-oracle.js) rather than
// read off the manual — the interesting cases (DEL backtracking a *command*,
// C-g's two stages, where point lands after a direction switch) are all ones
// where a plausible-sounding rule is wrong.
//
// The prompt is rendered by echo(), so it lands in the status bar; `status` is
// that line and `probes` capture it mid-search.

afterEach(cleanup);

const FIXTURE = "alpha beta gamma\ndelta beta epsilon";

describe("isearch: forward", () => {
  it("leaves point at the END of the match", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "RET"]);
    expect(r.text).toBe(FIXTURE);
    expect(r.point).toBe("1:11");
  });

  it("matches incrementally as characters are typed", () => {
    const r = emacs(FIXTURE, ["C-s", text("b"), probe(), text("e"), probe(), text("ta"), probe(), "RET"]);
    expect(r.probes.map((p) => p.point)).toEqual(["1:8", "1:9", "1:11"]);
    expect(r.probes[2].status).toContain("I-search: beta");
  });

  it("repeats with C-s", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "C-s", "RET"]);
    expect(r.point).toBe("2:11");
    expect(r.text).toBe(FIXTURE);
  });

  it("shows the prompt while the search is live", () => {
    const r = emacs(FIXTURE, ["C-s", probe(), text("be"), probe()]);
    expect(r.probes[0].status).toContain("I-search:");
    expect(r.probes[1].status).toContain("I-search: be");
  });
});

describe("isearch: backward", () => {
  it("leaves point at the BEGINNING of the match", () => {
    const r = emacs(FIXTURE, ["M->", "C-r", text("beta"), "RET"]);
    expect(r.point).toBe("2:7");
    expect(r.text).toBe(FIXTURE);
  });

  it("says so in the prompt", () => {
    const r = emacs(FIXTURE, ["M->", "C-r", text("beta"), probe(), "RET"]);
    expect(r.probes[0].status).toContain("I-search backward: beta");
  });

  it("repeats with C-r", () => {
    const r = emacs(FIXTURE, ["M->", "C-r", text("beta"), "C-r", "RET"]);
    expect(r.point).toBe("1:7");
  });

  it("keeps the match in place when a typed character extends it", () => {
    // Adding to the string extends a backward match to the RIGHT, so point does
    // not move as long as the match still starts where it did.
    const r = emacs("abc abd", ["M->", "C-r", text("a"), probe(), text("b"), "RET"]);
    expect(r.probes[0].point).toBe("1:5");
    expect(r.point).toBe("1:5");
  });
});

describe("isearch: switching direction", () => {
  it("C-r after a forward search lands on the other end of the SAME match", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "C-r", "RET"]);
    expect(r.point).toBe("1:7");
  });

  it("C-s after a backward search lands on the other end of the SAME match", () => {
    const r = emacs(FIXTURE, ["M->", "C-r", text("beta"), "C-s", "RET"]);
    expect(r.point).toBe("2:11");
  });

  it("carries on in the new direction on the next repeat", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "C-s", "C-r", "C-r", "RET"]);
    expect(r.point).toBe("1:7");
  });
});

describe("isearch: DEL backtracks a command, not a character", () => {
  it("undoes a repeat rather than shortening the string", () => {
    // C-s C-s DEL goes back to the FIRST match of "beta" — it does not become a
    // search for "bet".
    const r = emacs(FIXTURE, ["C-s", text("beta"), "C-s", "DEL", probe(), "RET"]);
    expect(r.probes[0].status).toContain("I-search: beta");
    expect(r.point).toBe("1:11");
  });

  it("undoes one typed character, restoring the earlier match", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "DEL", probe(), "RET"]);
    expect(r.probes[0].status).toContain("I-search: bet");
    expect(r.point).toBe("1:10");
  });

  it("does nothing at the start of the search", () => {
    const r = emacs(FIXTURE, ["C-s", "DEL", probe(), "RET"]);
    expect(r.probes[0].status).toContain("I-search:");
    expect(r.point).toBe("1:1");
    expect(r.text).toBe(FIXTURE);
  });
});

describe("isearch: exiting", () => {
  it("RET leaves point at the match", () => {
    const r = emacs(FIXTURE, ["C-s", text("gamma"), "RET"]);
    expect(r.point).toBe("1:17");
    expect(r.status).not.toContain("I-search");
  });

  it("Esc leaves point at the match", () => {
    const r = emacs(FIXTURE, ["C-s", text("gamma"), "ESC"]);
    expect(r.point).toBe("1:17");
    expect(r.status).not.toContain("I-search");
  });

  it("pushes the mark where the search started", () => {
    // isearch-done: a search that moved point leaves the mark at the origin, so
    // C-x C-x jumps back to it.
    const r = emacs(FIXTURE, ["C-f", "C-f", "C-s", text("beta"), "RET", probe(), "C-x C-x"]);
    expect(r.probes[0].status).toContain("Mark saved where search started");
    expect(r.point).toBe("1:3");
    expect(r.region).toBe("1:3-1:11");
  });

  it("does NOT push the mark when the search did not move point", () => {
    const r = emacs(FIXTURE, ["C-s", "RET", "C-x C-x"]);
    expect(r.point).toBe("1:1");
    expect(r.status).toContain("No mark set in this buffer");
  });
});

describe("isearch: C-g in two stages", () => {
  it("drops the failed characters and stays in the search", () => {
    const r = emacs(FIXTURE, ["C-s", text("bez"), probe(), "C-g", probe(), "RET"]);
    expect(r.probes[0].status).toContain("Failing I-search: bez");
    expect(r.probes[1].status).toContain("I-search: be");
    expect(r.probes[1].status).not.toContain("Failing");
    expect(r.point).toBe("1:9"); // still on the "be" match
  });

  it("aborts a succeeding search and returns point to the origin", () => {
    const r = emacs(FIXTURE, ["C-f", "C-f", "C-s", text("beta"), "C-g"]);
    expect(r.point).toBe("1:3");
    expect(r.status).toContain("Quit");
    expect(r.text).toBe(FIXTURE);
  });

  it("aborts on the second C-g, after the first rubbed out the failure", () => {
    const r = emacs(FIXTURE, ["C-f", "C-f", "C-s", text("bez"), "C-g", "C-g"]);
    expect(r.point).toBe("1:3");
    expect(r.status).toContain("Quit");
  });
});

describe("isearch: failing and wrapping", () => {
  it("says Failing and leaves point on the last match", () => {
    const r = emacs(FIXTURE, ["C-s", text("betaz"), probe(), "RET"]);
    expect(r.probes[0].status).toContain("Failing I-search: betaz");
    expect(r.point).toBe("1:11");
    expect(r.text).toBe(FIXTURE);
  });

  it("wraps to the top on the next C-s and says so", () => {
    const r = emacs(FIXTURE, ["M->", "C-s", text("alpha"), probe(), "C-s", probe(), "RET"]);
    expect(r.probes[0].status).toContain("Failing I-search: alpha");
    expect(r.probes[1].status).toContain("Wrapped I-search: alpha");
    expect(r.point).toBe("1:6");
  });

  it("wraps to the bottom for a backward search", () => {
    const r = emacs(FIXTURE, ["C-r", text("epsilon"), probe(), "C-r", probe(), "RET"]);
    expect(r.probes[0].status).toContain("Failing I-search backward: epsilon");
    expect(r.probes[1].status).toContain("Wrapped I-search backward: epsilon");
    expect(r.point).toBe("2:12");
  });
});

describe("isearch: smart case", () => {
  const CASED = "beta gamma\nBeta delta";

  it("folds case for an all-lower-case search string", () => {
    const r = emacs(CASED, ["C-s", text("beta"), "RET"]);
    expect(r.point).toBe("1:5");
    // …and the folded search still finds the capitalized one on a repeat.
    expect(emacs(CASED, ["C-s", text("beta"), "C-s", "RET"]).point).toBe("2:5");
  });

  it("goes case-sensitive as soon as an upper-case character is typed", () => {
    const r = emacs(CASED, ["C-s", text("Beta"), "RET"]);
    expect(r.point).toBe("2:5"); // skipped the lower-case "beta" on line 1
  });

  it("is case-sensitive for a mixed-case string too", () => {
    // "betA" matches nothing, so the search fails and point stays on the last
    // match — the one "bet" found.
    const r = emacs(CASED, ["C-s", text("betA"), probe(), "RET"]);
    expect(r.probes[0].status).toContain("Failing case-sensitive I-search: betA");
    expect(r.point).toBe("1:4");
  });
});

describe("isearch: keys that are not isearch keys", () => {
  it("exits the search and then executes the key", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "C-a"]);
    expect(r.point).toBe("1:1"); // C-a ran as move-beginning-of-line
    expect(r.text).toBe(FIXTURE);
    expect(r.status).not.toContain("I-search");
  });

  it("does not lose a key that only moves point", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "C-f"]);
    expect(r.point).toBe("1:12");
  });

  it("still has the mark at the origin afterwards", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "C-a", "C-x C-x"]);
    expect(r.point).toBe("1:1");
    expect(r.region).toBe("1:1-1:1");
  });

  it("runs an editing command with the search's own result", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "C-k"]);
    expect(r.text).toBe("alpha beta\ndelta beta epsilon");
    expect(r.point).toBe("1:11");
  });
});

describe("isearch: the search string is remembered", () => {
  it("C-s C-s reuses the last search string", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "RET", "C-s", "C-s", probe(), "RET"]);
    expect(r.probes[0].status).toContain("I-search: beta");
    expect(r.point).toBe("2:11");
  });

  it("C-s C-s does nothing when there is no previous search", () => {
    const r = emacs(FIXTURE, ["C-s", "C-s", "RET"]);
    expect(r.point).toBe("1:1");
    expect(r.text).toBe(FIXTURE);
  });

  it("an aborted search is not remembered", () => {
    const r = emacs(FIXTURE, ["C-s", text("beta"), "C-g", "C-s", "C-s", "RET"]);
    expect(r.point).toBe("1:1");
  });
});

describe("isearch: the region", () => {
  it("keeps a live region and drags it to the match", () => {
    // Verified against 27.1: the region stays active, the mark stays where
    // C-SPC put it, and no mark is pushed on exit while a region is live.
    const r = emacs(FIXTURE, ["C-SPC", "M-f", "C-s", text("ga"), "RET"]);
    expect(r.point).toBe("1:14");
    expect(r.region).toBe("1:1-1:14");
  });

  it("kills what the search selected", () => {
    const r = emacs(FIXTURE, ["C-SPC", "C-s", text("beta"), "RET", "C-w"]);
    expect(r.text).toBe(" gamma\ndelta beta epsilon");
    expect(r.point).toBe("1:1");
  });
});

describe("isearch: multi-byte lines", () => {
  it("counts runes, not bytes", () => {
    const r = emacs("héllo wörld\nhéllo again", ["C-s", text("wörld"), "RET"]);
    expect(r.point).toBe("1:12");
  });
});
