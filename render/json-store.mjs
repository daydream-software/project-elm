/* =============================================================================
 * json-store.mjs — the tiny "read/write a JSON file" patterns shared by
 * twitch.mjs (token cache), catalog.mjs, configs.mjs and the CLI's clip-list
 * cache. Two variants, matching what each caller actually had before this was
 * centralized:
 *  - readJson: tolerates a missing OR malformed file (catalog.mjs/configs.mjs
 *    already caught parse errors themselves).
 *  - readJsonStrict: tolerates only a MISSING file — a malformed one throws.
 *    twitch.mjs's token cache and the CLI's clip-list cache never caught parse
 *    errors, so a corrupt file surfaced loudly instead of being mistaken for
 *    "not logged in" / "no cache yet". Keep using the one each caller had.
 * ========================================================================== */

import fs from 'node:fs';

/**
 * Read and JSON.parse a file, tolerating a missing or malformed file.
 *
 * @param {string} file - Path to the JSON file.
 * @returns {*} The parsed JSON, or `null` if the file doesn't exist or fails to parse.
 */
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

/**
 * Read and JSON.parse a file, tolerating only a missing file — a malformed
 * (existing but corrupt) file throws, rather than being silently treated the
 * same as "doesn't exist yet".
 *
 * @param {string} file - Path to the JSON file.
 * @returns {*} The parsed JSON, or `null` if the file doesn't exist.
 * @throws {SyntaxError} If the file exists but isn't valid JSON.
 */
export function readJsonStrict(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * Write a value as pretty-printed JSON.
 *
 * @param {string} file - Path to write to.
 * @param {*} value - Value to serialize (via `JSON.stringify(value, null, 2)`).
 */
export function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
