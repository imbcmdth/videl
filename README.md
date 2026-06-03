<style>h1,h2,h3,h4 { border-bottom: 0; } </style>
<img src="videl-logo.svg" alt="Meet Videl" height="400" style="margin-right:12px" align="left"/>

# Videl

## _AKA: Comrade Video Element_

A modern, browser-native DASH adaptive streaming player built **entirely** from Web Components.

---

## Goals

- **DOM as data model.** The manifest is represented directly as a live HTML element tree (`<videl-presentation>` → `<videl-period>` → `<videl-adaptation-set>` → `<videl-representation>` → `<videl-segment>`). The browser's own DOM is the state machine.
- **No framework lock-in for consumers.** `<videl-player>` is a standard custom element that works inside any framework — or none.
- **Modern browsers only.** No polyfills. Targets ES2020+, native `DOMParser`, private class fields, `performance.now()`, and full MSE/EME APIs.
- **Observable internals.** Structured `videl:trace` events bubble from every significant operation so tooling and debug UIs can see exactly what the player is doing.

---

## Architecture

```
<videl-player>                  — MSE owner, main pump, bandwidth estimation
  └─ <videl-presentation>       — MPD root; sequential period advancement
       └─ <videl-period>        — A period; activates all content types simultaneously
            └─ <videl-adaptation-set>  — ABR selector for one content type
                 └─ <videl-representation>  — one quality level; owns init + segments
                      └─ <videl-segment>   — fetch leaf; one fMP4 segment
```

Each layer communicates upward via bubbling `CustomEvent`s and downward via the `videlUpdate(PlayerState)` pump call that flows from `<videl-player>` on every tick.

### Key design documents

| Document | Purpose |
|----------|---------|
| [`planning/ADD-001-dom-mirror-architecture.md`](planning/ADD-001-dom-mirror-architecture.md) | Top-level architecture overview |
| [`decisions/ADR-0001-mse-ownership-and-lifecycle.md`](decisions/ADR-0001-mse-ownership-and-lifecycle.md) | MSE ownership, rebuild procedure, init-segment invariants |
| [`LEMMA.md`](LEMMA.md) | Binding technical decisions (target, naming conventions, private fields, etc.) |

---

## Project structure

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

## Building

### Prerequisites

```bash
npm install
npx playwright install chromium   # first time only
```

### Library

```bash
npm run build
```

Outputs:
- `dist/index.js` — unminified ESM, used by the test suite
- `dist/index.min.js` + `dist/index.min.js.map` — minified with source maps, for production use

### Demo page

```bash
npm run build:demo
```

Outputs `demo/dist/bundle.js` (minified, with source map). Open `demo/index.html` in a browser — no server required.

---

## Testing

All tests run in a real Chromium browser via Playwright. No jsdom, no mocking of browser APIs.

```bash
npm test
```

The suite covers every deliverable: mixins, the MPD parser, each custom element in isolation, and `<videl-player>` integration tests (MSE lifecycle, ABR, buffer management, rendition switching, MSE rebuild).

---

## Events

`<videl-player>` surfaces all internal activity through bubbling custom events:

| Event | Detail | Fired by |
|-------|--------|---------|
| `videl:done` | `{ startTime, duration, bytes, fetchMs }` | `<videl-segment>` on successful append |
| `videl:done` | `{ periodId }` | `<videl-period>` on period end |
| `videl:done` | `{ src }` | `<videl-presentation>` on last period end |
| `videl:segment:error` | `{ error }` | `<videl-segment>` on fetch/append failure |
| `videl:representation:switched` | `{ from, to, contentType }` | `<videl-adaptation-set>` on ABR switch |
| `videl:mse:error` | `{ contentType, reason }` | `<videl-adaptation-set>` on unrecoverable buffer error |
| `videl:mse:incompatible` | `{ contentType, requiredCodecs }` | `<videl-adaptation-set>` when `changeType` fails |
| `videl:trace` | `{ category, action, data }` | All elements — structured internal tracing |

---

## Usage

```html
<script type="module" src="dist/index.min.js"></script>

<videl-player
  src="https://example.com/stream.mpd"
  buffer-ahead="30"
  tick-ms="250">
</videl-player>
```

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

### Attributes

| Attribute | Default | Description |
|-----------|---------|-------------|
| `src` | — | DASH MPD URL |
| `buffer-ahead` | `30` | Seconds of forward buffer to maintain before pausing segment fetches |
| `tick-ms` | `250` | Pump interval in milliseconds |
| `debug` | — | When present, all child elements render a debug overlay |

---

## License

[MIT](LICENSE) © 2026 Jon-Carlos Rivera

---

### Listening to trace events

```js
document.querySelector('videl-player').addEventListener('videl:trace', e => {
  const { category, action, data } = e.detail;
  console.log(`[${category}:${action}]`, data);
});
```
