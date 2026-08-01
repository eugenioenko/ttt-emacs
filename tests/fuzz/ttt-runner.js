// Drive ttt-emacs through the real binary's --exec harness and return the same
// {text, point, mark, regionActive} shape as the Emacs oracle.
//
//   ttt --size WxH --plugin init.lua --exec-split-on <SEP> --exec "<steps>" <input>
//
// The fuzzed tokens are sent as ordinary key events, so the plugin interprets
// them as Emacs commands exactly as a user would. TTT_CONFIG_DIR is an isolated
// dir whose settings.json pins the editing model (see parity.js) and which also
// keeps the developer's real ~/.config/ttt — and its auto-loading plugins/ dir —
// out of the run.
//
// NOTHING IS SAVED. The state comes from a `debug <path>` dump, which reports
// buffer text, cursor and selection directly. That is what lets this harness
// compare point and mark at all; the ttt-vim harness could only diff the saved
// file and was structurally blind to cursor position.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tokensToTttKeys } from "./keys.js";
import { TTT_SETTINGS, TTT_KEYBINDINGS, TTT_SIZE } from "./parity.js";
import { TTT_BINARY, EMACS_PLUGIN } from "../env.js";
import { lineColToPoint } from "./normalize.js";

// ASCII unit separator: never appears in a key name or a typed token, so a
// literal ";" or ":" is not mistaken for a step boundary.
const SEP = "\x1f";

const PLUGIN_LOAD_MS = Number(process.env.FUZZ_PLUGIN_WAIT || 500);
const SETTLE_MS = Number(process.env.FUZZ_SETTLE || 150);

function buildScript(tokens, statePath) {
  return [
    `wait ${PLUGIN_LOAD_MS}`, // let the plugin load and install its key interceptor
    // Pre-flight: take an early debug dump to verify the editor is stable
    // (no overlays open, buffer loaded). The run fails loudly here rather
    // than silently sending tokens to a not-yet-loaded plugin. On slow CI,
    // increase FUZZ_PLUGIN_WAIT (default 500 ms).
    `debug ${statePath}.pre`,
    ...tokensToTttKeys(tokens),
    `wait ${SETTLE_MS}`, // let the last command's redraw land
    `debug ${statePath}`,
    "quit",
  ].join(SEP);
}

// The debug dump reports a normalized selection (start before end) plus the
// cursor. The Emacs mark is the selection endpoint the cursor is NOT on.
function markFrom(state, lines, point) {
  const sel = state.selection;
  if (!sel || !sel.active || !sel.start || !sel.end) return null;
  const start = lineColToPoint(lines, sel.start.line, sel.start.col);
  const end = lineColToPoint(lines, sel.end.line, sel.end.col);
  return point === start ? end : start;
}

/**
 * Run `tokens` against `inputText` in the real ttt binary with ttt-emacs loaded.
 *
 * @param {string} inputText  starting buffer contents; must not end in "\n"
 *   (see parity.js / corpus.js).
 * @param {string[]} tokens   token stream (see keys.js).
 * @returns {{text: string, point: number, mark: number|null, regionActive: boolean}}
 */
export function runTtt(inputText, tokens) {
  if (inputText.endsWith("\n")) {
    throw new Error("ttt-runner: fixture must not end with a newline (see parity.js)");
  }
  const dir = mkdtempSync(join(tmpdir(), "fuzz-ttt-"));
  try {
    const configDir = join(dir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify(TTT_SETTINGS, null, 2), "utf8");
    // Frees C-b, C-p, C-t, C-q and M-t from ttt's force keys — without this
    // overlay those five tokens never reach the plugin and the run reports a
    // false divergence (or an overlay-open error). See parity.js.
    writeFileSync(join(configDir, "keybindings.json"), JSON.stringify(TTT_KEYBINDINGS, null, 2), "utf8");

    const input = join(dir, "buffer.txt");
    const statePath = join(dir, "state.json");
    writeFileSync(input, inputText, "utf8");

    execFileSync(
      TTT_BINARY,
      [
        "--size",
        TTT_SIZE,
        "--plugin",
        EMACS_PLUGIN,
        "--exec-split-on",
        SEP,
        "--exec",
        buildScript(tokens, statePath),
        input,
      ],
      {
        stdio: "pipe",
        timeout: Number(process.env.FUZZ_TTT_TIMEOUT || 30000),
        env: { ...process.env, TTT_CONFIG_DIR: configDir },
      },
    );

    // Pre-flight: the first debug dump verifies the editor is stable before any
    // tokens were sent. An overlay here means the plugin approval dialog (or
    // another modal) swallowed the keys — the run is invalid.
    const prePath = statePath + ".pre";
    let preState;
    try {
      preState = JSON.parse(readFileSync(prePath, "utf8"));
    } catch {
      // pre-flight dump was not produced — harness or binary failure
      throw new Error("ttt-runner: pre-flight debug dump missing — binary or harness failure");
    }
    if (preState.overlay) {
      throw new Error(
        `ttt-runner: overlay open before any tokens were sent: ${JSON.stringify(preState.overlay)} ` +
          `— plugin may not have loaded; increase FUZZ_PLUGIN_WAIT (current: ${PLUGIN_LOAD_MS} ms)`,
      );
    }
    if (!preState.buffer) {
      throw new Error("ttt-runner: pre-flight debug dump has no buffer");
    }

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (!state.buffer) throw new Error("ttt-runner: debug dump has no buffer");
    if (state.buffer.text_truncated) {
      throw new Error("ttt-runner: debug dump truncated the buffer text (>1000 lines)");
    }
    if (state.overlay) {
      // A dialog (command-palette, quit-confirm, …) swallowed keys; the state
      // is meaningless. Fail loudly rather than report a false match.
      throw new Error(`ttt-runner: an overlay was open at dump time: ${JSON.stringify(state.overlay)}`);
    }

    const lines = state.buffer.text;
    const point = lineColToPoint(lines, state.cursor.line, state.cursor.col);
    return {
      text: lines.join("\n"),
      point,
      mark: markFrom(state, lines, point),
      regionActive: Boolean(state.selection && state.selection.active),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
