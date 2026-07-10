# Project Elm

*A Daydream Software project.*

A small **local** tool to turn your own Twitch clips into a highlights reel — pick
your clips in a web UI, download them via the official Twitch API, then either play
them **live in OBS** (crossfade overlay, autoplays with sound) or **render one MP4**
to upload.

Everything runs on your machine. No hosted service, no client secret.

## How it works

```
   Web UI (select)          fetch (official API)              two ways to play
 ┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────────────────┐
 │ log in · browse  │ ──▶ │ download your clips │ ──▶ │ Live overlay (OBS, w/ sound) │
 │ clips · ✓ badge  │     │ (local MP4 files)   │     │   — or —                     │
 │ pick + download  │     └─────────────────────┘     │ Rendered MP4 (transitions +  │
 └──────────────────┘                                 │   loudnorm), for upload      │
                                                      └──────────────────────────────┘
```

Twitch clips can't be streamed live with sound (gated URLs / muted embeds), so we
**download** them first — then they're just local video files you can play or render
however you like.

## Requirements

- **Node.js 18+** (no npm dependencies).
- **ffmpeg + ffprobe** with the `drawtext` filter (built with libfreetype) — only for
  the *rendered MP4* path; a normal distro build works (`apt install ffmpeg`). Without
  `drawtext` it still renders, just without titles. Override the binaries with the
  `FFMPEG` / `FFPROBE` env vars if they're not on your `PATH`.
- A free **Twitch Public app** (Client ID only — no secret).

## Setup (one-time)

### 1. Create a Twitch application (Public)

1. Go to <https://dev.twitch.tv/console/apps> and sign in.
2. Click **Register Your Application**.
3. Fill in:
   - **Name:** any unique name (e.g. `mytwitchname-project-elm`). Must be unique across Twitch.
   - **OAuth Redirect URLs:** `http://localhost:3000`.
     *(Required by the form, but this tool never uses it — the Device Code Flow has no
     redirect. Any valid URL is fine.)*
   - **Category:** *Application Integration* (or *Other*).
   - **Client Type:** **Public** ← important. A Public app has **no client secret**,
     which is exactly what a local tool needs.
4. Click **Create**, open the app, and copy its **Client ID**.
   *(A Public app shows no client secret — that's normal and expected.)*

> The **Client ID is public by design** — it can't access your account on its own.
> Everything requires you to log in and consent (below). That's why it lives in a local
> `.env` rather than hardcoded in the source: so each user brings their own.

### 2. Configure

```bash
cp .env.example .env
# edit .env and set:  TWITCH_CLIENT_ID=<your Client ID>
```

## Usage

### Web UI (recommended)

```bash
node render/server.mjs
```

Open **<http://localhost:8080/>**:

1. **First run:** log in — a code + URL appear on the page. Open the URL, enter the
   code, sign in with your **channel account**, and approve the *manage clips*
   permission. The token is cached in `render/.token.json` (gitignored) and
   **auto-refreshed** — you won't log in again.
   *(Why a login? Downloading clips needs the broadcaster's consent, scope
   `channel:manage:clips`; Twitch gates it by design.)*
2. **Browse, pick & curate:** each clip shows a **✓ Downloaded** badge or a **Download**
   button. Download the ones you want (only downloaded clips can be included), then:
   - **Search** by title or game to filter a large clip list.
   - **Include** a clip (click its thumbnail or the checkbox) to add it to the reel.
   - **Hide** a clip you'll never feature with the **✕** in its corner — it leaves the
     grid (and the reel). Toggle **Show hidden** to bring hidden clips back and **↩ Unhide**.
   - **Delete a download** with the **🗑** on a downloaded card — removes the local `.mp4`
     (frees disk, leaves the reel). Reversible: the clip stays on Twitch, re-download anytime.
   - Choose the play **order** (Random / By views / Most recent / Oldest, or **Custom**).
     **Custom** reveals a **Sequence** strip — drag the tiles to set the exact play order.
   - Toggle the **Title card / Channel / Game** overlays.
3. **Save a configuration:** name it and click **Save** in the **Configurations** panel.
   A configuration is a named, reusable reel (clip selection + order + toggles) — save
   as many as you like (e.g. "Highlights", "Fails"), **search** the list by name, **Load**
   one back into the editor, **Duplicate**, or **Delete** it.
4. **Open overlay** (top-right, or a saved configuration's own **Open ↗**) → its live
   reel, at a stable URL: `/overlay/?config=<id>`. Add that URL as a **Browser source**
   in OBS — it autoplays with sound and crossfades between clips. Add several sources,
   each pointed at a different saved configuration, to run more than one reel at once.

   **This is fully live:** editing a saved configuration (adding/removing clips,
   re-ordering, toggling title/channel/game, even downloading or deleting a clip it
   uses) pushes to any overlay already open on it — no OBS source refresh needed. In
   the source's **Properties**, leave **"Shutdown source when not visible" unchecked**
   — that setting makes OBS reload the page on every scene switch, which is the hard
   refresh this is designed to avoid. With it unchecked, the overlay also auto-detects
   when its scene goes off program (OBS's built-in Browser Source API, no extra setup)
   and pauses + rewinds to clip 1, so it always resumes clean instead of mid-clip.

### Render a fixed MP4 instead

```bash
node render/render-reel.mjs render/realclips/manifest.json   # → render/realclips/reel.mp4
```

Play the MP4 as an OBS **Media source** or upload it anywhere.

### Optional CLI

The web UI covers everything, but the same fetch/select is available from the terminal
(handy for scripting):

```bash
node render/cli/fetch-clips.mjs login              # one-time browser authorization
node render/cli/fetch-clips.mjs list [--days N] [--first N]
node render/cli/fetch-clips.mjs pull <all|1,3,5>   # download + write manifest.json
```

## `manifest.json` schema (render path)

`fetch-clips pull` writes this for you, but you can edit it (titles, order, transitions)
or write it by hand. See `render/manifest.example.json`.

```jsonc
{
  "output": "reel.mp4",        // output path (relative to the manifest)
  "width": 1920, "height": 1080, "fps": 30,
  "transition": "fade",        // global default; any xfade type: fade, wipeleft,
                               //   slideup, circleopen, dissolve, smoothleft, …
  "transitionMs": 800,         // auto-shortened if a clip is too short
  "showTitles": true,
  "normalizeAudio": true,      // per-clip loudness normalization (loudnorm)
  "targetLUFS": -16,           // loudness target
  "fontfile": "/path/to.ttf",  // optional; auto-detected otherwise
  "clips": [
    { "file": "clip-01.mp4", "title": "Clutch of the year" },
    { "file": "clip-02.mp4", "title": "Fail",  "transition": "wipeleft" }, // per-cut override
    "clip-03.mp4"              // bare string = no title
  ]
}
```

Each clip is normalized (letterbox to the canvas, constant fps), loudness-evened
(`loudnorm`), titled (`drawtext`, first 4 s), then chained with a video crossfade
(`xfade`) + audio crossfade (`acrossfade`).

## Layout

| Path | What |
|---|---|
| `render/server.mjs` | local server: selection UI + Twitch API + serves everything |
| `render/curate/` | the selection web UI (Daydream-branded) |
| `render/twitch.mjs` | shared Twitch logic (auth / list / download) |
| `render/configs.mjs` | saved reel configurations (name + clips + order + toggles) |
| `render/cli/fetch-clips.mjs` | optional CLI over `twitch.mjs` |
| `render/render-reel.mjs` | render engine (clips + manifest → one MP4) |
| `overlay/` | the live crossfade overlay player (plays downloaded clips) |

`.env` (your Client ID), downloaded clips, and saved configurations (`render/configs/`)
are gitignored — all local user data.

## Notes

- **Download URLs are temporary** (signed, short-lived) — downloads happen immediately,
  so this is transparent.
- Twitch now offers **landscape and portrait** ("dual-format") clips; this tool takes
  the landscape version for a 16:9 reel.
- Verified end-to-end on a real channel: device-code login → list → download →
  live overlay (autoplays with sound in OBS) and rendered MP4.
- The overlay's live reload uses a plain SSE connection back to `render/server.mjs` —
  so the overlay only ever needs to be reachable at `http://localhost:8080`, same as
  the selection UI.

## Not yet

- Live-overlay loudness pre-pass (the *rendered* path already evens loudness).
- Intro/outro card, background music bed.
- Vertical/portrait output, A/V-drift check on a long (15–20 clip) reel.

## License

[MIT](LICENSE) © 2026 Daydream Software.

Bundled third-party asset: the **Geist** font (`fonts/`) is licensed under the SIL
Open Font License 1.1 — see [`fonts/OFL.txt`](fonts/OFL.txt).
