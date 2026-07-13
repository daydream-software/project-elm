/* =============================================================================
 * cli-util.mjs — tiny shared helper for the project's standalone CLI scripts
 * (render-reel.mjs, cli/fetch-clips.mjs).
 * ========================================================================== */

/**
 * Print an error prefixed with "✗ " and exit the process with a non-zero code.
 * Never returns — the process exits.
 *
 * @param {string} msg - Error message to print.
 */
export function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}
