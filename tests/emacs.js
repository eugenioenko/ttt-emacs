// Shared harness for the emacs-*.test.js suites.
//
// Every suite runs the REAL shipped plugin in the REAL binary and reads the
// result out of a `debug` dump, so an assertion can name the exact buffer text
// and the exact point. A screenshot alone cannot do that; it is captured too,
// but only for the echo area (the status bar) — see REFERENCE.md, "The echo
// area is the status bar".
//
// THE KEYBINDING OVERLAY IS NOT OPTIONAL. ttt registers a force key for
// command.palette, sidebar.toggle, terminal.toggle and editor.quit, which claim
// C-p, C-b, C-t and C-q; without the overlay those keys either never reach the
// plugin or open an overlay that swallows every key after it. The overlay and
// the editing-model settings are the same objects the differential fuzzer uses
// (fuzz/parity.js), so the suites test the configuration users are told to run.

import * as tui from "./tui.js";
import { createTempDir, createTempFile, cleanupDir } from "./helpers.js";
import { EMACS_PLUGIN } from "./env.js";
import { TTT_SETTINGS, TTT_KEYBINDINGS } from "./fuzz/parity.js";

// Time for the plugin to load and install its key.press interceptor. Anything
// sent before that lands in the editor as plain typing.
const PLUGIN_LOAD_MS = 300;

const dirs = [];

/** Remove every temp dir this module created. Call from afterEach. */
export function cleanup() {
  while (dirs.length) {
    try {
      cleanupDir(dirs.pop());
    } catch {}
  }
}

// --- key descriptions -------------------------------------------------------

// Named keys that are not a single character.
const BASE = {
  SPC: "space",
  DEL: "backspace",
  RET: "enter",
  TAB: "tab",
  ESC: "escape",
};

// One Emacs key ("C-x", "M-DEL", "<up>", "a") → one ttt --exec key combo.
function toCombo(desc) {
  let mods = "";
  let rest = desc;
  while (rest.length > 2 && (rest.startsWith("C-") || rest.startsWith("M-"))) {
    mods += rest[0] === "C" ? "ctrl+" : "alt+";
    rest = rest.slice(2);
  }
  if (BASE[rest]) {
    rest = BASE[rest];
  } else if (rest.length > 2 && rest.startsWith("<") && rest.endsWith(">")) {
    rest = rest.slice(1, -1);
  } else if ([...rest].length !== 1) {
    throw new Error(`emacs: unknown key description ${JSON.stringify(desc)}`);
  }
  return mods + rest;
}

/** Literal text to self-insert, as one step. */
export function text(s) {
  return { text: s };
}

/** Capture the screen mid-sequence; shows up in result.probes, in order. */
export function probe() {
  return { probe: true };
}

/** Wait, for the rare command that needs the editor to settle. */
export function pause(ms = 100) {
  return { wait: ms };
}

// --- running ----------------------------------------------------------------

// The status bar is the only rendering of the echo area, and it is the screen
// line carrying the core position segment.
//
// The position segment is not guaranteed to be there: the status bar drops
// right-hand segments when the left side is long, and the left side is the echo
// message PLUS the git branch name — so a long message under a long branch name
// evicts "Ln n, Col n" entirely. When that happens the status bar is still the
// last non-empty screen line, so fall back to it rather than reporting no echo
// area at all (which used to make the stub tests fail purely because of the
// checked-out branch's name).
function statusOf(screen) {
  const lines = screen.split("\n");
  for (const line of lines) {
    if (/Ln \d+, Col \d+/.test(line)) return line;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

// The debug dump is 0-based in both axes; the plugin (and Emacs) count from 1.
function posOf(p) {
  return `${p.line + 1}:${p.col + 1}`;
}

function stateOf(dump, screen) {
  if (!dump) throw new Error("emacs: no debug dump was produced");
  if (dump.buffer && dump.buffer.text_truncated) {
    throw new Error("emacs: debug dump truncated the buffer text");
  }
  const sel = dump.selection;
  const vp = dump.viewport;
  return {
    text: dump.buffer ? dump.buffer.text.join("\n") : "",
    point: posOf(dump.cursor),
    top: vp ? vp.top_line + 1 : null, // first visible line, 1-based
    height: vp ? vp.height : null,
    regionActive: Boolean(sel && sel.active),
    region: sel && sel.active && sel.start && sel.end ? `${posOf(sel.start)}-${posOf(sel.end)}` : null,
    overlay: dump.overlay ? dump.overlay.type : null,
    status: statusOf(screen || ""),
    screen: screen || "",
  };
}

/**
 * Open `content` in ttt with ttt-emacs loaded, send `keys`, and report the
 * final state.
 *
 * @param {string} content  buffer contents; must NOT end in a newline (ttt's
 *   loader drops it and `showTrailingNewline` is off, so a trailing newline
 *   would make `text` disagree with what was written).
 * @param {Array<string|object>} keys  Emacs key descriptions ("C-a", "M-DEL",
 *   "C-x C-s", "<up>", "a"), or text()/probe()/pause() steps.
 * @returns {{text: string, point: string, region: string|null,
 *   regionActive: boolean, overlay: string|null, status: string,
 *   screen: string, file: string, probes: object[]}}
 */
export function emacs(content, keys = [], opts = {}) {
  if (content.endsWith("\n")) {
    throw new Error("emacs: fixture must not end with a newline");
  }
  const dir = createTempDir();
  dirs.push(dir);
  const file = createTempFile(dir, opts.name || "buffer.txt", content);

  tui.start("--plugin", EMACS_PLUGIN, file);
  tui.seedConfig("settings.json", TTT_SETTINGS);
  tui.seedConfig("keybindings.json", TTT_KEYBINDINGS);
  tui.wait(PLUGIN_LOAD_MS);

  const probes = [];
  for (const step of keys) {
    if (typeof step === "string") {
      for (const part of step.split(" ")) tui.press(toCombo(part));
      continue;
    }
    if (step.text !== undefined) {
      tui.type(step.text);
      continue;
    }
    if (step.wait !== undefined) {
      tui.wait(step.wait);
      continue;
    }
    if (step.probe) {
      probes.push({ snap: tui.snapshot(), state: tui.state() });
      continue;
    }
    throw new Error(`emacs: unknown step ${JSON.stringify(step)}`);
  }

  tui.wait(150);
  const snap = tui.snapshot();
  const dump = tui.state();
  const { snapshots, states } = tui.run();

  const out = stateOf(states[dump], snapshots[snap]);
  out.file = file;
  out.probes = probes.map((p) => stateOf(states[p.state], snapshots[p.snap]));
  return out;
}
