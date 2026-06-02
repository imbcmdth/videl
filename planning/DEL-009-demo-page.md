# DEL-009: Demo Page

**Depends on:** DEL-008 (`<videl-castro>` complete and working)  
**Deliverable type:** Static web page + Vite build config

---

## Summary

A standalone, publicly deployable demo page for `videl-castro`. Lets anyone drop in a DASH URL and watch it play, with a live event log showing what the player is doing internally. The page is a static build — no server required — suitable for deployment to GitHub Pages, Netlify, or any static host.

---

## Layout

```
┌─────────────────────────────────────────────┐
│  videl-castro demo                          │
├──────────────────────────┬──────────────────┤
│                          │  Event Log       │
│   <media-controller>     │  ─────────────── │
│     <videl-castro>       │  12:04:01.234    │
│     media-chrome UI      │  videl:done      │
│   </media-controller>    │  <videl-segment> │
│                          │  ─────────────── │
│                          │  12:04:01.100    │
│                          │  videl:repr...   │
├──────────────────────────┴──────────────────┤
│  [dropdown ▼] [text input          ] [Load] │
└─────────────────────────────────────────────┘
```

Two-column above a URL bar. On narrow viewports (< 768px): single column, event log below player.

---

## URL Bar

### Pre-configured dropdown

Seeded with known public DASH streams. Selecting one populates the text input and loads immediately.

Suggested initial entries (verify availability before shipping):

| Label | URL |
|-------|-----|
| Big Buck Bunny (DASH-IF) | `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` |
| Elephant Dream (DASH-IF) | `https://dash.akamaized.net/akamai/bbb_30fps/bbb_with_multiple_tiled_thumbnails.mpd` |
| DASH-IF Live Sim | `https://livesim.dashif.org/livesim/testpic_2s/Manifest.mpd` |
| Tears of Steel (Bitmovin) | `https://bitmovin-a.akamaihd.net/content/sintel/sintel.mpd` |

The dropdown also shows user-saved URLs (see LocalStorage below), labelled by their hostname.

### Text input

Free-text DASH URL. Pressing Enter or clicking **Load** sets `<videl-castro src="...">` and begins playback.

### LocalStorage persistence

On **Load**: if `localStorage` is available, append the URL to a stored list (`videl-castro-demo:urls`). Cap at 10 entries (drop oldest). Previously saved URLs appear at the top of the dropdown under a "Recent" group, separated from the pre-configured group by an `<optgroup>` divider. On page load, if saved URLs exist, pre-populate the text input with the most recent one (do not auto-play).

If `localStorage` is not available (private browsing, storage blocked): degrade silently — no error, no UI indication required.

---

## Event Log

A scrollable panel listing all `videl:*` events fired by the player in real time.

### What to capture

Listen on the `<videl-castro>` element for the following events (all bubble):

| Event | Fields to display |
|-------|------------------|
| `videl:done` | `event.target.tagName`, `detail` (if any) |
| `videl:segment:error` | `event.target.tagName`, `detail.error.message` |
| `videl:representation:switched` | `detail.from`, `detail.to`, `detail.contentType` |
| `videl:mse:error` | `detail.contentType`, `detail.reason` |
| `videl:mse:incompatible` | `detail.contentType`, `detail.requiredCodecs` |

Also log player-level lifecycle events from the internal `<video>` (re-fired by `<videl-castro>`):

| Event | Fields to display |
|-------|------------------|
| `play` | — |
| `pause` | — |
| `seeking` | `currentTime` |
| `seeked` | `currentTime` |
| `waiting` | — |
| `canplay` | — |
| `ended` | — |

### Log entry format

Each entry shows:
- **Timestamp:** wall-clock time to millisecond precision (`HH:MM:SS.mmm`)
- **Event name:** e.g. `videl:done`
- **Source:** the element tag name (for `videl:*`) or `<video>` (for media events)
- **Detail:** compact one-line JSON of relevant detail fields; omit empty details

Example entries:
```
12:04:01.234  videl:done              <videl-segment>   {"startTime":4,"duration":2}
12:04:01.100  videl:representation:switched  <videl-adaptation-set>  {"from":"1","to":"3","contentType":"video"}
12:04:00.010  canplay                 <video>
```

### Log controls

- **Clear** button: empties the log
- **Pause** toggle: freezes the display (events still accumulate in a buffer; unpausing flushes them in order)
- **Auto-scroll:** log auto-scrolls to the latest entry unless the user has manually scrolled up; resume auto-scroll when user scrolls back to the bottom
- Cap the log at **500 entries** (drop oldest) to prevent unbounded memory growth

---

## Technical Implementation

### Build

The project build tool is **esbuild** (see LEMMA.md). The demo is built as a simple bundle alongside the main library.

- **Entry:** `demo/main.ts` — TypeScript entry point
- **Output:** `demo/dist/bundle.js` — single self-contained ESM bundle
- **HTML:** `demo/index.html` — static file referencing `dist/bundle.js` with a relative `<script type="module">` tag. All asset paths are relative so the page works from any subdirectory.
- **Build script:** add a `build:demo` entry to `package.json` scripts:
  ```
  esbuild demo/main.ts --bundle --format=esm --outfile=demo/dist/bundle.js
  ```
- No config file required. No HTML transform step — `index.html` is static and references the output file directly.

### No demo-specific framework

The demo shell is plain TypeScript + vanilla DOM. No Lit, no React. The player itself is `<videl-castro>` wrapped in `<media-controller>` from `media-chrome`; the surrounding UI (event log, URL bar) is authored in plain TS.

### Deployment

Add a GitHub Actions workflow (`.github/workflows/demo.yml`) that:
1. Runs `npm run build:demo` on push to `main`
2. Deploys `demo/` (the `index.html` + `dist/` subdirectory) to the `gh-pages` branch via `actions/deploy-pages`

Include a `README` note with the live URL template: `https://<org>.github.io/videl-castro/`.

---

## Functional Acceptance Criteria

1. Loading a valid DASH URL begins playback within 5 seconds on a normal connection.
2. All `videl:*` events fired during playback appear in the event log within one rendering frame of firing.
3. Selecting a pre-configured URL from the dropdown loads and plays it.
4. Entering a URL in the text box and pressing Enter loads it.
5. A successfully loaded URL is saved to LocalStorage; it appears in the dropdown "Recent" group on next page load.
6. LocalStorage cap: after entering 11 URLs, only the 10 most recent are stored.
7. Unavailable LocalStorage (mocked): no error is thrown; no Recent group appears in the dropdown.
8. The **Clear** button empties the visible log.
9. The **Pause** toggle freezes visible log updates; unpause flushes buffered entries in order.
10. Log auto-scrolls to the bottom when new entries arrive, unless the user has scrolled up.
11. Log is capped at 500 entries; the 501st entry removes the oldest.
12. The page is usable on a 768px-wide viewport (single-column layout).
13. The built `dist/` directory contains only static files and loads correctly when served from a subdirectory (no absolute root paths).
14. The GitHub Actions workflow successfully deploys to `gh-pages` on push to `main`.

---

## Test Approach

**Framework:** Playwright end-to-end tests against the built demo (`npm run build && npx serve dist`).

Key test scenarios:
- Load a pre-configured URL; assert player reaches `canplay` state and event log shows `canplay`.
- Enter a custom URL; assert it appears in dropdown on page reload.
- Fill 11 URLs; assert only 10 in localStorage.
- Clear log; assert log is empty.
- Pause log; trigger events; assert new entries absent from display; unpause; assert they appear.
- Resize to 375px wide; assert layout stacks correctly (no overflow).
