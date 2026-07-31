// Single source of truth for the ttt binary and plugin paths used by every test.
//
// The binary is resolved in this order:
//   1. TTT_BIN env var — an explicit path (CI sets this after building ttt).
//   2. .ttt-bin/ttt in the repo root — populated by `npm run prepare`, which
//      clones/builds ttt (see scripts/prepare-ttt.sh).
//
// The plugin lives at the repo root (this is a single-plugin repo).
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..");
export const EMACS_PLUGIN = join(ROOT, "init.lua");

export const TTT_BINARY = process.env.TTT_BIN || join(ROOT, ".ttt-bin", "ttt");

if (!existsSync(TTT_BINARY)) {
  throw new Error(
    `ttt binary not found at ${TTT_BINARY}.\n` +
      `Run "npm run prepare" to clone and build ttt, or set TTT_BIN to an existing binary.`,
  );
}
