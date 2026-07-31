import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function createTempDir() {
  return mkdtempSync(join(tmpdir(), "ttt-test-"));
}

export function createTempFile(dir, name, content) {
  const filePath = join(dir, name);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

export function createMultiLineFile(dir, name, lines) {
  const content = Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join("\n");
  return createTempFile(dir, name, content);
}

export function readFile(path) {
  return readFileSync(path, "utf8");
}

export function fileExists(path) {
  return existsSync(path);
}

export function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}
