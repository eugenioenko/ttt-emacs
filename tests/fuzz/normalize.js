// State normalization + comparison.
//
// Unlike the ttt-vim harness — which can only compare the SAVED FILE and is
// therefore structurally blind to cursor position — the Emacs oracle reports
// buffer text, point AND mark. So we compare all three, and off-by-one motion
// bugs (a whole bug class the Vim harness cannot see) show up directly.
//
// The comparison unit is an EditorState:
//
//   { text: string,            // full buffer contents
//     point: number,           // 1-based Emacs buffer position
//     mark: number|null,       // 1-based, or null when never set
//     regionActive: boolean }  // transient-mark-mode region ⇔ ttt selection
//
// Both runners are pinned so that `buffer.text.join("\n")` on the ttt side is
// byte-identical to `(buffer-string)` on the Emacs side (parity.js:
// showTrailingNewline off, fixtures with no trailing newline). There is no
// trailing-newline fudge to apply — text is compared raw.

// --- point ↔ (line, col) ----------------------------------------------------

// ttt reports a 0-based (line, col) where col is a RUNE index; Emacs reports a
// 1-based character offset. Convert with rune-aware line lengths.
export function lineColToPoint(lines, line, col) {
  const l = Math.max(0, Math.min(line, lines.length - 1));
  let off = 0;
  for (let i = 0; i < l; i++) off += [...lines[i]].length + 1; // +1 for the "\n"
  const width = [...(lines[l] ?? "")].length;
  off += Math.max(0, Math.min(col, width));
  return off + 1; // Emacs point-min is 1
}

// Inverse, for readable reports.
export function pointToLineCol(text, point) {
  const lines = text.split("\n");
  let remaining = point - 1;
  for (let i = 0; i < lines.length; i++) {
    const width = [...lines[i]].length;
    if (remaining <= width) return { line: i, col: remaining };
    remaining -= width + 1;
  }
  const last = lines.length - 1;
  return { line: last, col: [...lines[last]].length };
}

// --- comparison -------------------------------------------------------------

// How strictly to compare the mark.
//
//   "region" (default) — compare `regionActive` always, and `mark` only when
//     both sides report an active region. ttt exposes the mark ONLY as a
//     selection anchor in the debug dump, so an inactive-but-set Emacs mark
//     (the state left behind by C-w, M-w, M->, C-y …) is not observable on the
//     ttt side; comparing it would be comparing against nothing.
//   "strict" — compare `mark` unconditionally. Turn this on once ttt-emacs
//     exposes its mark independently of the selection (see DESIGN.md).
//   "ignore" — text and point only.
export const DEFAULT_MARK_MODE = process.env.FUZZ_MARK_MODE || "region";

export function compareStates(a, b, { markMode = DEFAULT_MARK_MODE } = {}) {
  const reasons = [];
  if (a.text !== b.text) reasons.push("text");
  if (a.point !== b.point) reasons.push("point");

  if (markMode !== "ignore") {
    if (a.regionActive !== b.regionActive) reasons.push("regionActive");
    const compareMark = markMode === "strict" || (a.regionActive && b.regionActive);
    if (compareMark && a.mark !== b.mark) reasons.push("mark");
  }

  return { equal: reasons.length === 0, reasons };
}

export function equalStates(a, b, opts) {
  return compareStates(a, b, opts).equal;
}

// --- reporting --------------------------------------------------------------

function fmtPos(text, pos) {
  if (pos == null) return "nil";
  const { line, col } = pointToLineCol(text, pos);
  return `${pos} (line ${line}, col ${col})`;
}

// A small unified-ish report: line-by-line text diff plus the point/mark/region
// scalars. `a` is the oracle (emacs), `b` is ttt.
export function diffStates(a, b) {
  const la = a.text.split("\n");
  const lb = b.text.split("\n");
  const n = Math.max(la.length, lb.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const x = la[i];
    const y = lb[i];
    if (x === y) {
      rows.push(`  ${i + 1} | ${x ?? ""}`);
    } else {
      rows.push(`- ${i + 1} | ${x ?? "<missing>"}`);
      rows.push(`+ ${i + 1} | ${y ?? "<missing>"}`);
    }
  }
  const scalar = (label, av, bv) => rows.push(`${av === bv ? "  " : "! "}${label}: emacs=${av}  ttt=${bv}`);
  rows.push("");
  scalar("point", fmtPos(a.text, a.point), fmtPos(b.text, b.point));
  scalar("mark", fmtPos(a.text, a.mark), fmtPos(b.text, b.mark));
  scalar("region", String(a.regionActive), String(b.regionActive));
  if (a.errors && a.errors.length) {
    rows.push(`  emacs errors: ${a.errors.map((e) => `${e.index}:${e.token}:${e.message}`).join(" | ")}`);
  }
  return rows.join("\n");
}

// Compact one-line summary of a state, for logs.
export function summarize(s) {
  return `point=${s.point} mark=${s.mark ?? "nil"} region=${s.regionActive} text=${JSON.stringify(s.text)}`;
}
