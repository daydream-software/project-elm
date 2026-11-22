# Changelog

Every commit on `main` is a release. Releases are numbered **rN**, where N is the
commit's position in `main`'s first-parent history:

- before committing, the next number is `git rev-list --count --first-parent main` + 1;
- to find the commit for a release: `git rev-list --first-parent --reverse main | sed -n '<N>p'`.

Each commit adds its own entry at the top of this file, in the same commit. The
heading is `## rN — YYYY-MM-DD — <one-line summary>`: the startup update check reads
those summaries from the remote's copy of this file and lists what a `git pull` would
bring in, as `+rN: <summary>` (falling back to the commit subject for a release with
no entry).

## r20 — 2026-11-21 — Fix no-store cache replaying edited clips; update check lists releases

### Fixed
- A downloaded clip edited or replaced on disk (e.g. trimmed in a video editor and
  saved over `render/realclips/<id>.mp4`) is now picked up: live overlays switch to the
  new version at their next loop, without an OBS source refresh. Previously they kept
  playing the original, because Chromium's in-memory media cache ignores
  `Cache-Control: no-store` and even survives a page reload. The curate preview and
  thumbnail grab no longer show stale video either.

### Added
- The server watches `render/realclips/` and live-reloads every overlay that uses a
  changed clip. Clip URLs are now versioned by file mtime and size (`?v=…`).
- The update check (CLI dashboard and curate UI banner) lists the incoming releases
  with their changelog summary, e.g. `+r21: <summary>`, instead of only a commit count.

### Docs
- This changelog, backfilled for r1–r19.
- README: how to edit a downloaded clip so the reel picks it up.

## r19 — 2026-10-11 — Recover from mid-operation Twitch 401s

### Fixed
- A Helix 401 mid-operation (access token expired or revoked early) now triggers one
  shared token refresh and a retry; the login is only dropped if the refresh token is
  rejected too.
- Only an "Invalid refresh token" 400 counts as a dead login; other 400s keep the token.
- Two concurrent **Update** requests can no longer both start a catalog refresh.
- **Open overlay** is re-enabled after re-logging in mid-session.

## r18 — 2026-10-11 — Remove temporary PR screenshots

### Internal
- Removed the temporary PR screenshots added in r17.

## r17 — 2026-10-11 — Temporary PR screenshots

### Internal
- Temporary PR screenshots (removed in r18).

## r16 — 2026-10-11 — Re-login from the web UI when the Twitch token is dead

### Fixed
- The web UI offers to log in again when the cached Twitch token is dead, instead of
  reporting "authorized" forever and requiring `render/.token.json` to be deleted by hand.
  Transient Twitch failures (5xx/network) keep the token.

## r15 — 2026-07-14 — Document dashboard keybinds and the update check

### Docs
- Documented the CLI dashboard keybinds and the startup update check.

## r14 — 2026-07-14 — Dashboard keybinds: quit, open in browser

### Added
- CLI dashboard keybinds: `q` quits, `b` opens the web UI in the browser.

## r13 — 2026-07-14 — Startup update check

### Added
- Startup update check (`git fetch` + compare, warn-only — never pulls), shown in the
  CLI dashboard and as a banner in the curate UI.

## r12 — 2026-07-14 — Fix overlay clips cutting early under load

### Fixed
- Overlay clips no longer cut early under load.

### Changed
- Clip MP4s are streamed from disk with HTTP `Range` support instead of being read
  fully into memory first.

## r11 — 2026-07-13 — New website URL

### Docs
- Switched to the new website URL.

## r10 — 2026-07-13 — Docs site with install and usage guides

### Added
- `docs/` GitHub Pages site with install and usage guides.

### Internal
- JSDoc across `render/`; deduplicated shared JSON/SSE helpers.

## r9 — 2026-07-12 — Curate UI redesign

### Changed
- Redesigned curate UI: persistent reel panel, consolidated card actions, config
  quick-switch.

### Fixed
- Assorted curate UI bugfixes.

## r8 — 2026-07-11 — Always-reachable config Save

### Changed
- Config **Save** is always reachable, and the status line is always visible.

### Fixed
- Stale or misleading save messages.

## r7 — 2026-07-11 — Fix false orphans and dropped uncataloged clips

### Fixed
- False "orphaned clip" flags, and overlays dropping clips that were downloaded but not
  yet cataloged.

### Internal
- Deduplicated catalog mapping and Twitch pagination.

## r6 — 2026-07-11 — Clip preview, local catalog, full Twitch pagination

### Added
- Clip preview in the curate UI.
- Local clip catalog with orphan tracking (clips deleted on Twitch).
- Full Twitch pagination.
- Live web UI / overlay status in the CLI dashboard.

### Changed
- Reorganized curate UI.

## r5 — 2026-07-10 — Live CLI status dashboard

### Added
- Live CLI status dashboard with server and Twitch activity metrics.

## r4 — 2026-07-10 — Saved reel configs, live reload, OBS auto-pause

### Added
- Saved reel configurations, each with its own overlay URL.
- Live overlay reload over SSE when a configuration is saved.
- Auto-pause while the OBS source is off program.
- Clip and configuration search.

## r3 — 2026-07-10 — Remove old iframe code

### Removed
- Old iframe-based playback code.

## r2 — 2026-07-10 — Hide/show, drag-and-drop sequence, delete download

### Added
- Curation UI: hide/show clips, custom drag-and-drop sequence, delete a download.

## r1 — 2026-07-09 — Initial release

### Added
- Initial release: OBS Browser-source overlay that plays clips back-to-back with
  crossfades, local curation server and UI, Twitch login and clip download
  (`render/fetch-clips.mjs`), and an ffmpeg reel renderer (`render/render-reel.mjs`).
