# Videl

<img src="demo/images/videl-logo.svg" alt="Meet Videl" height="400" style="margin-right:12px" align="right"/>

#### _AKA: Comrade Video Element_

A modern, browser-native DASH adaptive streaming player built **entirely** from Web Components.

---

#### Goals

- **DOM as data model.** The manifest is represented directly as a live HTML element tree (`<videl-presentation>` → `<videl-period>` → `<videl-adaptation-set>` → `<videl-representation>` → `<videl-segment>`). The browser's own DOM is the state machine.
- **No framework lock-in for consumers.** `<videl-player>` is a standard custom element that works inside any framework — or none.
- **Modern browsers only.** No polyfills. Targets ES2020+, native `DOMParser`, private class fields, `performance.now()`, and full MSE/EME APIs.
- **Observable internals.** Structured `videl:trace` events bubble from every significant operation so tooling and debug UIs can see exactly what the player is doing.

---

#### Architecture

```
<videl-player>                  — MSE owner, main pump, bandwidth estimation, playlist sequencer
  └─ <videl-presentation>       — MPD root; self-populates from src; sequential period advancement
       └─ <videl-period>        — A period; activates all content types simultaneously
            └─ <videl-adaptation-set>  — ABR selector for one content type
                 └─ <videl-representation>  — one quality level; owns init + segments
                      └─ <videl-segment>   — fetch leaf; one fMP4 segment
```

Each layer communicates upward via bubbling `CustomEvent`s and downward via the `videlUpdate(PlayerState)` pump call that flows from `<videl-player>` on every tick.

##### State communication

State is communicated between parent and child elements via the `videl-state` attribute (not the `slot` attribute — see ADR-0002). The defined values are:

| Value | Meaning |
|-------|---------|
| `videl-state="active"` | Element is the currently playing participant |
| `videl-state="next"` | Element is prefetching in anticipation of becoming active |
| *(absent)* | Element is idle |

This keeps the DOM structure stable regardless of playback state — elements never move or are re-slotted to reflect state changes, which makes DevTools inspection coherent and CSS styling straightforward:

```css
videl-presentation                        { opacity: 0.5; }
videl-presentation[videl-state="active"]  { opacity: 1.0; }
videl-presentation[videl-state="next"]    { opacity: 0.75; }
```

##### Shadow DOM composition

Every element exposes a default `<slot>` so its children are always present in the composed tree for DevTools inspection. Technical children (periods, adaptation sets, etc.) are hidden by targeted `::slotted` rules with `!important` — required because an element's own shadow `:host { display: block }` outranks a containing shadow's `::slotted()` in the CSS cascade without it.

##### Key design documents

| Document | Purpose |
|----------|---------|
| [`planning/ADD-001-dom-mirror-architecture.md`](planning/ADD-001-dom-mirror-architecture.md) | Top-level architecture overview |
| [`decisions/ADR-0001-mse-ownership-and-lifecycle.md`](decisions/ADR-0001-mse-ownership-and-lifecycle.md) | MSE ownership, rebuild procedure, init-segment invariants |
| [`decisions/ADR-0002-attribute-state-vs-slot-state.md`](decisions/ADR-0002-attribute-state-vs-slot-state.md) | Why `videl-state` attribute replaces `slot` for state management |
| [`planning/DEL-010-playlist-presentations.md`](planning/DEL-010-playlist-presentations.md) | Multi-presentation playlist feature spec |
| [`LEMMA.md`](LEMMA.md) | Binding technical decisions, hard-won implementation notes |

---

#### Project structure

```
src/
  index.ts                    — library entry point
  player-state.ts             — PlayerState interface
  managed-source-buffer.ts    — serialised SourceBuffer wrapper
  trace.ts                    — videl:trace event utility
  mixins/
    pick-one-mixin.ts         — PickOneMixin (one active child at a time)
    pick-n-mixin.ts           — PickNMixin (one active child per key)
    sequential-mixin.ts       — SequentialMixin (videl:done advances next sibling)
  elements/
    videl-segment.ts
    videl-representation.ts
    videl-adaptation-set.ts
    videl-period.ts
    videl-presentation.ts
    videl-player.ts
  parser/
    mpd-parser.ts             — DOMParser-based DASH MPD → element tree
demo/
  index.html                  — static demo page
  main.ts                     — demo logic (event log, URL bar, LocalStorage)
  dist/                       — built demo bundle (git-ignored)
test/
  fixtures/                   — fMP4 test segments + MPD fixtures
  *.spec.ts                   — Playwright tests (real browser, real MSE)
dist/                         — built library (git-ignored)
  index.js                    — unminified ESM bundle
  index.min.js                — minified ESM bundle
  index.min.js.map            — source map
planning/                     — architecture and deliverable specs
decisions/                    — ADRs
```

---

#### Building

##### Prerequisites

```bash
npm install
npx playwright install chromium   ### first time only
```

##### Library

```bash
npm run build
```

Outputs:
- `dist/index.js` — unminified ESM, used by the test suite
- `dist/index.min.js` + `dist/index.min.js.map` — minified with source maps, for production use

##### Demo page

```bash
npm run build:demo
```

Outputs `demo/dist/bundle.js` (minified, with source map). Open `demo/index.html` in a browser — no server required.

---

#### Testing

All tests run in a real Chromium browser via Playwright. No jsdom, no mocking of browser APIs.

```bash
npm test
```

The suite covers every deliverable: mixins, the MPD parser, each custom element in isolation, `<videl-player>` integration tests (MSE lifecycle, ABR, buffer management, rendition switching, MSE rebuild), and multi-presentation playlist sequencing.

---

#### Usage

##### Single stream (legacy / simple)

```html
<script type="module" src="dist/index.min.js"></script>

<videl-player
  src="https://example.com/stream.mpd"
  buffer-ahead="30"
  tick-ms="250">
</videl-player>
```

##### Declarative playlist

Place multiple `<videl-presentation>` children inside `<videl-player>`. Each presentation owns its own MPD URL and optional display metadata. The player sequences through them automatically, prefetching the next presentation while the current one plays.

```html
<script type="module" src="dist/index.min.js"></script>

<style>
  videl-presentation                        { opacity: 0.5; cursor: pointer; }
  videl-presentation[videl-state="active"]  { opacity: 1.0; outline: 2px solid #4af; }
  videl-presentation[videl-state="next"]    { opacity: 0.75; }
</style>

<videl-player>
  <videl-presentation src="https://example.com/ep1.mpd" duration="2700">
    <img src="ep1-thumb.jpg" alt="Episode 1" />
    <h3>Episode 1: Pilot</h3>
  </videl-presentation>

  <videl-presentation src="https://example.com/ep2.mpd" duration="2580">
    <img src="ep2-thumb.jpg" alt="Episode 2" />
    <h3>Episode 2: The Return</h3>
  </videl-presentation>
</videl-player>
```

Each `<videl-presentation>` element IS the playlist card. Put any content directly inside it — no wrapper element or `slot` attribute required. The element fetches and parses its own MPD when `videl-state` becomes `next` (prefetch) or `active` (inline activation). Technical children (`<videl-period>` etc.) injected by the parser are hidden by CSS but remain in the DOM for DevTools inspection.

With [`media-chrome`](https://github.com/muxinc/media-chrome) controls:

```html
<media-controller>
  <videl-player slot="media" src="https://example.com/stream.mpd"></videl-player>
  <media-control-bar>
    <media-play-button></media-play-button>
    <media-time-range></media-time-range>
    <media-time-display show-duration></media-time-display>
    <media-mute-button></media-mute-button>
    <media-volume-range></media-volume-range>
    <media-fullscreen-button></media-fullscreen-button>
  </media-control-bar>
</media-controller>
```

##### `<videl-player>` attributes

| Attribute | Default | Description |
|-----------|---------|-------------|
| `src` | — | DASH MPD URL (single-stream mode; ignored if `<videl-presentation>` children are present) |
| `buffer-ahead` | `30` | Seconds of forward buffer to maintain before pausing segment fetches |
| `tick-ms` | `250` | Pump interval in milliseconds |
| `debug` | — | When present, all child elements render a debug overlay showing their `videl-state` and internal counters |

##### `<videl-presentation>` attributes

| Attribute | Description |
|-----------|-------------|
| `src` | MPD URL. Fetched when `videl-state` becomes `next` or `active`. |
| `duration` | Display duration in seconds shown before the manifest is fetched (optional hint for UI). |
| `media-presentation-duration` | Populated from the parsed manifest. Drives `MediaSource.duration` and therefore `videoElement.seekable`. |
| `type` | `static` or `dynamic` (from manifest). |

---

#### Events

`<videl-player>` surfaces all internal activity through bubbling custom events:

| Event | Detail | Fired by |
|-------|--------|---------|
| `videl:done` | `{ startTime, duration, bytes, fetchMs }` | `<videl-segment>` on successful append |
| `videl:done` | `{ periodId }` | `<videl-period>` on period end |
| `videl:done` | `{ src }` | `<videl-presentation>` on last period end |
| `videl:playlist:advance` | `{ from, to, index }` | `<videl-player>` when advancing to the next presentation in a playlist |
| `videl:segment:error` | `{ error }` | `<videl-segment>` on fetch/append failure |
| `videl:representation:switched` | `{ from, to, contentType }` | `<videl-adaptation-set>` on ABR switch |
| `videl:mse:error` | `{ contentType, reason }` | `<videl-adaptation-set>` on unrecoverable buffer error |
| `videl:mse:incompatible` | `{ contentType, requiredCodecs }` | `<videl-adaptation-set>` when `changeType` fails |
| `videl:trace` | `{ category, action, data }` | All elements — structured internal tracing |

##### Trace categories

| Category | Covers |
|----------|--------|
| `lifecycle` | `src` changes, seeks, connect/disconnect |
| `mse` | MediaSource / SourceBuffer creation, duration, teardown |
| `buffer` | `appendBuffer` calls (start, complete, error) |
| `fetch` | Network requests for init and media segments |
| `abr` | Rendition selection and switches |
| `pump` | Pump tick decisions (buffer gating, no-ops, segment activation) |
| `timeline` | Segment duration drift tracking and adjustments |

##### Listening to trace events

```js
document.querySelector('videl-player').addEventListener('videl:trace', e => {
  const { category, action, data } = e.detail;
  console.log(`[${category}:${action}]`, data);
});
```

---

#### Implementation notes

##### Text tracks

`content-type="text"` adaptation sets are intentionally skipped during MSE buffering. MP4-encapsulated text (TTML, WebVTT-in-ISOBMFF) requires in-band parsing and injection into the `<video>` element's native `TextTrack` API — this is outside the current scope and will be addressed in a dedicated deliverable.

---

#### License

[MIT](LICENSE) © 2026 Jon-Carlos Rivera
