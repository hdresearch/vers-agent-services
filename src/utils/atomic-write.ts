import { writeFileSync, renameSync, existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file atomically: write to a `.tmp` sibling, then rename.
 * On POSIX, `rename` is atomic within the same filesystem, so readers
 * will always see either the old complete file or the new complete file,
 * never a half-written one.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, data, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Recover from a crash that left a `.tmp` file.
 *
 * Strategy:
 * - If `filePath` exists and is valid (parseable), remove stale `.tmp` if present.
 * - If `filePath` is missing or corrupt, and `.tmp` exists and is valid, promote `.tmp`.
 * - If both are corrupt or missing, do nothing (store will start fresh).
 *
 * @param filePath   Path to the main data file
 * @param validate   Optional validator; defaults to `JSON.parse`
 * @returns `"recovered"` if `.tmp` was promoted, `"ok"` if main file was fine, `"empty"` if no usable file
 */
export function recoverTmpFile(
  filePath: string,
  validate?: (content: string) => void,
): "recovered" | "ok" | "empty" {
  const tmpPath = filePath + ".tmp";
  const isValid = validate ?? ((content: string) => JSON.parse(content));

  const mainExists = existsSync(filePath);
  const tmpExists = existsSync(tmpPath);

  if (mainExists) {
    try {
      const content = readFileSync(filePath, "utf-8");
      isValid(content);
      // Main file is good — clean up stale tmp if present
      if (tmpExists) {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      return "ok";
    } catch {
      // Main file is corrupt, fall through to try tmp
    }
  }

  if (tmpExists) {
    try {
      const content = readFileSync(tmpPath, "utf-8");
      isValid(content);
      // tmp is valid — promote it
      renameSync(tmpPath, filePath);
      return "recovered";
    } catch {
      // tmp is also corrupt — clean it up
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  return "empty";
}
