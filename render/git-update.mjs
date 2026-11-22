/* =============================================================================
 * git-update.mjs — one-shot "is a newer commit available?" check, run once at
 * server startup (see server.mjs). `git fetch` only refreshes the local copy
 * of the remote's refs; nothing here ever merges, rebases, or pulls. Warn-only
 * by design — the user runs `git pull` themselves, from the CLI dashboard row
 * or the curate UI banner this feeds.
 * ========================================================================== */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FETCH_TIMEOUT_MS = 10_000;

let status = { checked: false };
// The in-flight git child, if any — used by killActiveCheck() so the shutdown path (and
// our own timeout below) can reap it. `git fetch` over http(s) forks its own
// `git-remote-http` helper to do the actual network I/O, so killing just the top-level
// `git` pid leaves that helper orphaned and running (confirmed empirically — this is
// also why this uses `child_process.spawn` with `detached: true` + a process-group kill
// rather than `execFile`'s built-in `timeout`: execFile does NOT actually detach the
// child into its own process group despite accepting the option, confirmed empirically —
// only a directly `spawn`-ed child does, and a process-group kill via `-pid` needs that
// to reach the helper as well as the top-level process).
let activeChild = null;

/**
 * Run a git subcommand in `cwd`, buffering its stdout. Never prompts for credentials (a
 * hung prompt would otherwise stall the dashboard's TTY) and is capped at
 * {@link FETCH_TIMEOUT_MS} so an unreachable remote can't hang startup.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>} Trimmed stdout.
 */
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      detached: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    activeChild = child;
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => killActiveCheck(), FETCH_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); activeChild = null; reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeChild = null;
      if (code === 0) resolve(stdout.trim());
      // A signal (not a normal exit code) means killActiveCheck() fired — either our own
      // FETCH_TIMEOUT_MS timer or an external shutdown call — so name it as a timeout
      // rather than the opaque "exited with code null" a bare exit code would give.
      else if (signal) reject(new Error(`git ${args.join(' ')} timed out after ${FETCH_TIMEOUT_MS / 1000}s (${signal})`));
      else reject(new Error(stderr.trim() || `git ${args.join(' ')} exited with code ${code}`));
    });
  });
}

/**
 * Parse the one-line release summaries out of CHANGELOG.md text, i.e. headings of the
 * form `## rN — YYYY-MM-DD — <summary>` (see CHANGELOG.md's header for the numbering).
 * Control characters are stripped: the summary comes from the remote and ends up
 * printed raw in the TTY dashboard, where an ANSI escape could repaint the terminal.
 *
 * @param {string} text - CHANGELOG.md contents.
 * @returns {Map<number, string>} Release number → summary (headings without one are skipped).
 */
export function parseChangelogSummaries(text) {
  const summaries = new Map();
  const heading = /^## r(\d+)\s+[—–-]\s+\d{4}-\d{2}-\d{2}\s+[—–-]\s+(.+?)\s*$/gm;
  for (const m of text.matchAll(heading)) {
    const summary = m[2].replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (summary) summaries.set(Number(m[1]), summary);
  }
  return summaries;
}

/**
 * The releases on `upstream` that HEAD doesn't have yet, oldest first. Every commit on
 * main is a release numbered by its position in main's first-parent history (see
 * CHANGELOG.md), so the incoming ones are numbered on from the merge base and labelled
 * with the UPSTREAM CHANGELOG.md summary — or the commit subject when there's no entry.
 * In a shallow clone the truncated history makes the numbering wrong, so releases come
 * back unnumbered (`release: null`) and labelled with their commit subject.
 *
 * @param {string} cwd - Repo root.
 * @param {string} upstream - e.g. `origin/main`.
 * @returns {Promise<{release: ?number, summary: string}[]>}
 */
async function incomingReleases(cwd, upstream) {
  const base = await git(cwd, ['merge-base', 'HEAD', upstream]);
  const baseRelease = Number(await git(cwd, ['rev-list', '--count', '--first-parent', base]));
  const log = await git(cwd, ['log', '--first-parent', '--reverse', '--format=%s', `${base}..${upstream}`]);
  const subjects = log ? log.split('\n') : [];
  const shallow = (await git(cwd, ['rev-parse', '--is-shallow-repository'])) === 'true';
  let summaries = new Map();
  if (!shallow) {
    try { summaries = parseChangelogSummaries(await git(cwd, ['show', `${upstream}:CHANGELOG.md`])); }
    catch { /* no CHANGELOG.md upstream — commit subjects only */ }
  }
  return subjects.map((subject, i) => {
    const release = shallow ? null : baseRelease + 1 + i;
    return { release, summary: summaries.get(release) || subject };
  });
}

/** Kill the in-flight git subprocess and any of its own children (e.g. git-remote-http). */
export function killActiveCheck() {
  if (activeChild) { try { process.kill(-activeChild.pid, 'SIGTERM'); } catch { /* already exited */ } }
}

/**
 * Fetch the tracking remote and compare HEAD against it. Never throws — any
 * failure (offline, not a git checkout, no upstream configured, git missing)
 * resolves to a `{ error }` result instead of rejecting, since a broken check
 * must never take startup down with it.
 *
 * @param {string} cwd - Repo root.
 * @returns {Promise<object>} The new status (also cached — see {@link getStatus}).
 */
export async function checkForUpdate(cwd) {
  const checkedAt = Date.now();
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    return (status = { checked: true, checkedAt, supported: false });
  }
  try {
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    let upstream;
    try {
      upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch {
      return (status = { checked: true, checkedAt, supported: true, tracked: false, branch });
    }
    await git(cwd, ['fetch', '--quiet', upstream.split('/')[0]]);
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    // The release list only decorates the "behind" notice: if resolving it fails, the
    // notice still shows (with the bare count), so an error here is deliberately non-fatal.
    let releases = [];
    if (behind > 0) {
      try { releases = await incomingReleases(cwd, upstream); } catch { releases = []; }
    }
    return (status = {
      checked: true, checkedAt, supported: true, tracked: true,
      branch, upstream, ahead, behind, updateAvailable: behind > 0, releases,
    });
  } catch (e) {
    return (status = { checked: true, checkedAt, supported: true, error: e.message });
  }
}

/**
 * The most recent {@link checkForUpdate} result.
 *
 * @returns {object} `{ checked: false }` before the startup check has resolved.
 */
export function getStatus() { return status; }
