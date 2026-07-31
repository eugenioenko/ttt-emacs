import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TTT_BINARY as BINARY } from "./env.js";

const KEY_MAP = {
  arrow_left: "left",
  arrow_right: "right",
  arrow_up: "up",
  arrow_down: "down",
  page_up: "pgup",
  page_down: "pgdn",
};

let commands = [];
let args = [];
let snapCount = 0;
let stateCount = 0;
let tmpDir = "";
let size = "120x40";

export function start(...startArgs) {
  commands = [];
  snapCount = 0;
  stateCount = 0;
  size = "120x40";
  tmpDir = mkdtempSync(join(tmpdir(), "ttt-bb-"));
  args = [];
  for (const a of startArgs) {
    args.push(a);
  }
}

// Override the terminal size for this run (default 120x40). Reset by start().
export function setSize(w, h) {
  size = `${w}x${h}`;
}

// Simulate a mouse click at screen coordinates (col x, row y).
export function click(x, y) {
  commands.push(`click ${x} ${y}`);
}

export function type(text) {
  let start = 0;
  while (start < text.length && text[start] === " ") {
    commands.push("key space");
    start++;
  }
  let end = text.length;
  while (end > start && text[end - 1] === " ") {
    end--;
  }
  if (start < end) {
    commands.push(`type ${text.slice(start, end)}`);
  }
  for (let k = end; k < text.length; k++) {
    commands.push("key space");
  }
}

export function press(key) {
  const mapped = KEY_MAP[key] || key;
  commands.push(`key ${mapped}`);
}

export function pressChord(first, second) {
  const a = KEY_MAP[first] || first;
  const b = KEY_MAP[second] || second;
  commands.push(`key ${a} ${b}`);
}

export function exec(command) {
  commands.push(`exec "${command}"`);
}

export function panel(id) {
  commands.push(`panel ${id}`);
}

export function wait(ms = 200) {
  commands.push(`wait ${ms}`);
}

export function waitFor(_text) {
  commands.push("wait 200");
}

export function waitStable(ms = 200) {
  commands.push(`wait ${ms}`);
}

export function snapshot() {
  const idx = snapCount++;
  const path = join(tmpDir, `snap-${idx}.txt`);
  commands.push(`screenshot ${path}`);
  return idx;
}

// Capture the `debug` dump: buffer text, cursor, selection, overlay. Returns an
// index into run()'s `states` array. A screenshot can only show what happens to
// be painted; the dump is what lets a test assert an exact buffer and an exact
// cursor position.
export function state() {
  const idx = stateCount++;
  const path = join(tmpDir, `state-${idx}.json`);
  commands.push(`debug ${path}`);
  return idx;
}

// Write a file into this run's isolated TTT_CONFIG_DIR before the binary starts.
// Must be called after start(), which creates the directory. ttt-emacs needs it
// for the keybindings overlay that frees C-b/C-p/C-t/C-q (see fuzz/parity.js).
export function seedConfig(name, contents) {
  const dir = join(tmpDir, "config");
  mkdirSync(dir, { recursive: true });
  const text = typeof contents === "string" ? contents : JSON.stringify(contents, null, 2);
  writeFileSync(join(dir, name), text, "utf8");
}

// ASCII unit separator: cannot appear in a key name or typed text, so tests are
// free to send a literal ";" (a Vim motion, among other things) without it
// being mistaken for a command boundary.
const SEP = "\x1f";

export function run(timeout = 15000) {
  commands.push("quit");
  const script = commands.join(SEP);

  try {
    execFileSync(BINARY, ["--size", size, "--exec-split-on", SEP, "--exec", script, ...args], {
      encoding: "utf8",
      timeout,
      stdio: "pipe",
      // Isolate from the real ~/.config/ttt — settings toggles persist and race across test files.
      env: { ...process.env, TTT_CONFIG_DIR: join(tmpDir, "config") },
    });
  } catch (err) {
    if (err.status !== null && err.status !== 0 && err.status !== undefined) {
      // non-zero exit is ok for quit-confirm tests etc.
    }
  }

  const snapshots = [];
  for (let i = 0; i < snapCount; i++) {
    try {
      snapshots.push(readFileSync(join(tmpDir, `snap-${i}.txt`), "utf8"));
    } catch {
      snapshots.push("");
    }
  }

  const states = [];
  for (let i = 0; i < stateCount; i++) {
    try {
      states.push(JSON.parse(readFileSync(join(tmpDir, `state-${i}.json`), "utf8")));
    } catch {
      states.push(null);
    }
  }

  cleanup();
  return { snapshots, states };
}

export function kill() {
  // no-op: compatibility with old afterEach
}

function cleanup() {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    tmpDir = "";
  }
}
