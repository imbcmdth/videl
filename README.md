# Videl

<img src="demo/images/videl-logo.svg" alt="Meet Videl" height="400" style="margin-right:12px" align="right"/>

#### _AKA: Comrade Video Element_

A modern, browser-native DASH adaptive streaming player built **entirely** from Web Components.

---

#### Goals

- **DOM as data model.** The manifest is represented directly as a live HTML element tree (`<videl-presentation>` → `<videl-period>` → `<videl-adaptation-set>` → `<videl-representation>` → `<videl-segment>`). The browser's own DOM is the state machine.
- **No framework lock-in for consumers.** `<videl-player>` is a standard custom element that works inside any framework — or none.
- **Modern browsers only.** No polyfills. Targets ES2020+, native `DOMParser`, private class fields, `performance.now()`, and the full MSE API.
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
| [`LEMMA.md`](LEMMA.md) | Binding technical decisions, hard-won implementation notes |
| [`planning/ADD-001-dom-mirror-architecture.md`](planning/ADD-001-dom-mirror-architecture.md) | Original top-level architecture overview |
| [`decisions/ADR-0001-mse-ownership-and-lifecycle.md`](decisions/ADR-0001-mse-ownership-and-lifecycle.md) | MSE ownership, rebuild procedure, init-segment invariants |
| [`decisions/ADR-0002-attribute-state-vs-slot-state.md`](decisions/ADR-0002-attribute-state-vs-slot-state.md) | Why `videl-state` attribute replaces `slot` for state management |
| [`decisions/ADR-0004-text-source-buffer.md`](decisions/ADR-0004-text-source-buffer.md) | TextSourceBuffer design: fMP4 text demuxing, VTT/TTML, sidecar tracks |
| [`decisions/ADR-0005-time-handling-and-stream-formats.md`](decisions/ADR-0005-time-handling-and-stream-formats.md) | Unified wall-clock epoch time coordinate system (live/VOD/live-DVR) |
| [`decisions/DEL-010-playlist-presentations.md`](decisions/DEL-010-playlist-presentations.md) | Multi-presentation playlist feature spec |

---

#### Project structure

```
src/
  index.ts                    — library entry point (re-exports all public API)
  player-state.ts             — PlayerState interface (passed on every pump tick)
  trace.ts                    — videl:trace event utility
  foundation.ts               — shared LitElement base helpers
  icons.ts                    — SVG icon strings for the control bar
  mixins/
    pick-one-mixin.ts         — PickOneMixin (one active child at a time)
    pick-n-mixin.ts           — PickNMixin (one active child per content-type key)
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
    template-utils.ts         — SegmentTemplate URL expansion helpers
  lib/
    ergo-mse/                 — MSE abstraction layer
      ergo-media-source.ts    — ErgoMediaSource wrapper (open/attach/endOfStream)
      managed-source-buffer.ts — serialised SourceBuffer operation queue with wall-clock coordinate translation
      text-source-buffer.ts   — ISourceBuffer implementation for text tracks
      text-codec.ts           — codec string classification (wvtt / stpp / sidecar)
      synthetic-time-ranges.ts — mutable TimeRanges used by TextSourceBuffer
      offset-time-ranges.ts   — TimeRanges wrapper that shifts all values by a constant offset (wall-clock translation)
      i-source-buffer.ts      — ISourceBuffer interface
    mp4/
      box-utils.ts            — ISOBMFF box iteration and field readers
      sidx-parser.ts          — sidx box parser → segment byte-range entries
      text-demuxer.ts         — Fmp4TextDemuxer (moov/moof/mdat → TextSamples)
    vtt/
      parser.ts               — wvtt sample parser (vttc/vtte → VTTCue)
      file-parser.ts          — sidecar .vtt file parser
    ttml/
      parser.ts               — stpp sample parser (TTML XML → VTTCue)
demo/
  index.html                  — static demo page
  main.ts                     — demo logic (event log, URL bar, LocalStorage)
  dist/                       — built demo bundle (git-ignored)
test/
  fixtures/                   — fMP4 test segments + MPD fixtures
  *.spec.ts / *.test.ts       — Playwright tests (real browser, real MSE)
dist/                         — built library (git-ignored)
  index.js                    — unminified ESM bundle
  index.min.js                — minified ESM bundle
  index.min.js.map            — source map
planning/                     — architecture and deliverable decisions/                    — ADRs, architecture docs, deliverable specs
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

---

#### API reference

Three categories govern the `videl-` prefix on attributes:

| Origin | Prefix | Written by |
|--------|--------|-----------|
| **Manifest** | none | MPD parser, from MPD XML |
| **User config** | none | Consumer / developer |
| **Internal state** | `videl-` | videl element itself |

##### Time coordinate system

All time values throughout the Videl API are in **wall-clock epoch seconds** (seconds since Unix epoch, Jan 1 1970) unless explicitly marked `(player-time)`. This unified coordinate system simplifies live streaming:

- **VOD**: `wallAnchor = 0`, so wall-clock equals `video.currentTime` (identity).
- **Live**: `wallAnchor = activationNow` (current epoch seconds), so `currentWallTime = video.currentTime + wallAnchor`.
- **Live-DVR**: `wallAnchor = activationNow − timeShiftBufferDepth`, so the DVR window start maps to `currentTime = 0`.

Callers always work in wall-clock epoch seconds; `ISourceBuffer` implementations (ManagedSourceBuffer, TextSourceBuffer) translate to/from player-time internally.

---

##### `<videl-player>`

**Attributes**

| Attribute | Origin | Default | Description |
|-----------|--------|---------|-------------|
| `src` | user config | — | MPD URL for single-stream mode. Setting it replaces the current presentation and restarts the stream. Ignored when `<videl-presentation>` children are present. |
| `tick-ms` | user config | `250` | Pump interval in milliseconds. Controls how frequently `videlUpdate` is called down the active path. |
| `buffer-ahead` | user config | `30` | Seconds of media to buffer ahead of `currentTime` before the pump pauses segment fetching. |
| `debug` | user config | — | When present, propagates a `debug` attribute to every descendant element, enabling their visual debug overlays. |
| `time-shift-buffer-depth-default` | user config | `0` | Default DVR window depth in seconds for live streams when the MPD does not declare `timeShiftBufferDepth`. Set to `0` for pure-live (no DVR window / seeking disabled), or a positive number to enable seeking within the window. Overridden by MPD's `timeShiftBufferDepth` attribute if present. |
| `playlist-collapsed` | user config | — | When present, collapses the playlist column regardless of how many presentations exist. Consumer-set CSS hook; the player never sets or clears this itself. |
| `videl-no-playlist` | internal state | — | Present when fewer than two `<videl-presentation>` children exist. CSS uses it to collapse the playlist column. |
| `videl-user-inactive` | internal state | — | Present after the inactivity timer fires (3 s of no pointer activity). CSS uses it to hide controls. Cleared immediately on any pointer activity. |
| `videl-bandwidth` | internal state | — | EWMA-estimated download bandwidth in bps (rounded integer). Updated after each qualifying segment fetch. Useful for custom ABR overrides and monitoring dashboards. |

**JavaScript API**

| Member | Type | Description |
|--------|------|-------------|
| `src` | `string` (get/set) | Reflects the `src` attribute. Setting it starts a new load. |
| `play()` | `() => Promise<void>` | Delegates to the internal `<video>` element. |
| `pause()` | `() => void` | Delegates to the internal `<video>` element. |
| `currentTime` | `number` (get/set) | Reads/seeks the playhead in player-time (`video.currentTime`). Setter triggers a pump reset so the next tick targets the new position. Callers should use `PlayerState.currentWallTime` for component logic. |
| `duration` | `number` (get) | Returns `media-presentation-duration` from the active presentation, falling back to `video.duration`. |
| `paused` | `boolean` (get) | Proxies `video.paused`. |
| `buffered` | `TimeRanges` (get) | Proxies `video.buffered`. |
| `readyState` | `number` (get) | Proxies `video.readyState`. |
| `volume` | `number` (get/set) | Proxies `video.volume`. |
| `muted` | `boolean` (get/set) | Proxies `video.muted`. |
| `playbackRate` | `number` (get/set) | Proxies `video.playbackRate`. |
| `bufferAhead` | `number` (get/set) | Reads/writes the forward buffer target in seconds. |
| `nativeVideo` | `HTMLVideoElement` (get) | Direct reference to the internal `<video>` element for advanced use cases. |

**PlayerState** (`videlUpdate` argument)

Every element receives a `PlayerState` object on each pump tick. Key fields:

| Member | Type | Description |
|--------|------|-------------|
| `currentWallTime` | `number` | **Wall-clock epoch seconds** — the primary time field. Use this in all component logic for seeking, buffering, and segment selection. Equals `video.currentTime + wallAnchor`. |
| `wallAnchor` | `number` | Wall-clock epoch second at `video.currentTime = 0`. Set by the player during setup. VOD = 0, live = `activationNow`, live-dvr = `activationNow − timeShiftBufferDepth`. |
| `currentTime` | `number` | **Player-time** (`video.currentTime`). Kept for logging/debugging; prefer `currentWallTime` for logic. |
| `buffered` | `TimeRanges` | Combined buffered ranges from all SourceBuffers, in **wall-clock epoch seconds** (via OffsetTimeRanges). |
| `sourceBuffered` | `Map<string, TimeRanges>` | Per-content-type buffered ranges in **wall-clock epoch seconds**, keyed by `content-type` attribute (e.g. `"video"`, `"audio"`). |
| `seekableStart`, `seekableEnd` | `number` | **Wall-clock epoch seconds**. The playable range — used by presentation controls (seekbar) to calculate progress and dispatch seeks. |
| `bufferAhead`, `bandwidth`, `playbackRate`, `paused`, `muted` | — | Standard playback state. |

---

##### `<videl-presentation>`

**Attributes**

| Attribute | Origin | Description |
|-----------|--------|-------------|
| `src` | user config | MPD URL. Fetched automatically when `videl-state` becomes `next` (prefetch) or `active` (inline). |
| `duration` | user config / manifest | Display duration in seconds. Consumer may declare it before the manifest is fetched for playlist UI. Overwritten by `media-presentation-duration` once the MPD is parsed. |
| `media-presentation-duration` | manifest | Authoritative total duration from `MPD@mediaPresentationDuration`. Used for `endOfStream` gating and the seekbar range. |
| `min-buffer-time` | manifest | Minimum buffer time from `MPD@minBufferTime`. Informational; available for consumer tooling. |
| `type` | manifest | `"static"` (VOD) or `"dynamic"` (live). Controls seekbar behaviour and `MediaSource.duration`. |
| `debug` | user config | Enables the visual debug overlay showing type, state, duration, populate status, and current time. |
| `videl-state` | internal state | Slot state: `"next"` → `"active"` → absent. Set by the parent player; drives the populate → activate cascade. |
| `videl-generated` | internal state | Present on presentations created by the player from its own `src` attribute (single-stream mode). Lets CSS suppress card styling for auto-generated presentations. |
| `videl-user-inactive` | internal state | Mirrored from the parent player when the inactivity timer fires. CSS uses it to fade out the control bar. |
| `videl-populated` | internal state | Present once the MPD has been successfully fetched and `<videl-period>` children injected. Lets test harnesses await population and CSS show loading states. |
| `videl-current-time` | internal state | Playhead position in **wall-clock epoch seconds**, stamped on every pump tick. For VOD this equals `video.currentTime`; for live it includes the `wallAnchor` offset. Mirrors the primary playback position for external observers. |
| `videl-paused` | internal state | Present when playback is paused. Stamped by the pump. |
| `videl-volume` | internal state | Current volume level (0–1), stamped by the pump. |
| `videl-muted` | internal state | Present when audio is muted. Stamped by the pump. |
| `videl-seekable-start` | internal state | Start of the seekable range in **wall-clock epoch seconds**. For VOD this is `0`; for live with DVR this tracks the window start; for pure-live this is `0` (no seek). |
| `videl-seekable-end` | internal state | End of the seekable range in **wall-clock epoch seconds**. For VOD this is the total duration; for live it tracks the current live edge. |
| `no-seek` | internal state | Present on live streams with no DVR window (timeShiftBufferDepth = 0). Signals the UI that seeking is disabled. |
| `videl-menu-open` | internal state | Which informational menu is open: `"audio"`, `"text"`, or `"quality"`. Absent when no menu is open. Also stamped onto the active `<videl-period>` so its CSS can reveal the matching rows. |
| `videl-fullscreen` | internal state | Present while the player element is the fullscreen element. Drives the fullscreen/exit-fullscreen icon swap. |

**JavaScript API**

| Member | Type | Description |
|--------|------|-------------|
| `videlUpdate(state)` | `(PlayerState) => void` | Called by the parent player on each pump tick. Stamps playback state onto reactive properties and forwards the tick to the active period. |
| `videlPopulate()` | `() => Promise<void>` | Explicitly triggers MPD fetch and period injection. Idempotent — safe to call multiple times. Called by the player before MSE setup in playlist mode. |

---

##### `<videl-period>`

**Attributes**

| Attribute | Origin | Description |
|-----------|--------|-------------|
| `period-id` | manifest | Value of `Period@id` from the MPD. Present in `videl:done` event payloads. |
| `start` | manifest | Period start time in **wall-clock epoch seconds** (for live) or presentation-relative seconds (for VOD). For live, equals `availabilityStartTime + presentationOffset`. For VOD, computed cumulatively when `Period@start` is absent. |
| `duration` | manifest | Period duration in seconds. When absent the period is open-ended (live) and `videl:done` never fires. |
| `debug` | user config | Enables the visual debug overlay showing period id, state, start/duration, and open menu. |
| `videl-state` | internal state | Slot state: `"next"` → `"active"` → absent. Set by the parent presentation. |
| `videl-menu-open` | internal state | Which informational menu is revealed on this period: `"audio"`, `"text"`, or `"quality"`. Set by the parent presentation; CSS uses it to show the matching adaptation-set rows in the popup. Removed on deactivation. |
| `videl-done` | internal state | Present once this period has fired `videl:done` in the current activation session. Prevents duplicate events. Removed when `videl-state` is cleared. |

**JavaScript API**

| Member | Type | Description |
|--------|------|-------------|
| `videlUpdate(state)` | `(PlayerState) => void` | Called by the parent presentation on each pump tick. Fans the state out to active adaptation sets and checks period-completion conditions. |
| `selectAdaptationSet(contentType, candidates)` | `(string, VidelAdaptationSet[]) => VidelAdaptationSet \| null` | Overridable hook called when the period activates. Return the adaptation set to activate for the given content type. Default: first in DOM order. |

---

##### `<videl-adaptation-set>`

**Attributes**

| Attribute | Origin | Description |
|-----------|--------|-------------|
| `content-type` | manifest | Media type: `"video"`, `"audio"`, or `"text"`. Inferred from `AdaptationSet@contentType`, MIME type, or codec string. |
| `mime-type` | manifest | Base MIME type (e.g. `video/mp4`). Used with `codecs` to construct the `addSourceBuffer` type string. |
| `codecs` | manifest | Codec string (e.g. `avc1.640028`). Inherited by child representations when not overridden at that level. |
| `lang` | manifest | BCP-47 language tag. Displayed in the audio/subtitle menu row. |
| `label` | manifest (derived) | Human-readable display label for the track menu row. Resolved in order: `Label` child element → `label` attribute → `lang` → `content-type` → `"track"`. |
| `abr-safety-factor` | user config | Fraction of measured bandwidth used as the ABR budget ceiling (default `0.8`). Lowers the effective threshold to leave headroom for network variance. |
| `forced-rep` | user config | ID of the representation to pin, disabling ABR. Set by a left-click on a quality row; can also be declared by the consumer. Cleared when the pinned representation is removed. |
| `debug` | user config | Enables the visual debug overlay showing content type, state, and ABR safety factor. |
| `videl-state` | internal state | Slot state: `"next"` → `"active"` → absent. |
| `videl-text-none` | internal state | Present on the synthetic "None" text adaptation set. When active, calls `TextSourceBuffer.hide()` instead of appending data (subtitles off by default). |
| `videl-active-codecs` | internal state | Full MIME+codecs string of the representation currently being decoded (e.g. `video/mp4; codecs="avc1.640028"`). Set by `#performSwitch`; used to detect when `changeType()` is needed on an ABR switch. Absent when not active. |

**JavaScript API**

| Member | Type | Description |
|--------|------|-------------|
| `videlUpdate(state)` | `(PlayerState) => void` | Called by the parent period on each pump tick. Runs ABR selection, performs representation switches, and forwards the tick to the active representation. |
| `sourceBuffer` | `ISourceBuffer \| null` (get/set) | The `SourceBuffer` (or `TextSourceBuffer`) instance shared across all representations in this set. Set by `<videl-player>` during MSE setup; forwarded to child representations on activation. |
| `isFullyFetched` | `boolean` (get) | `true` when the active representation's last segment has been appended. Used by the parent period to detect full-period buffering for seamless transitions. Always `false` for text adaptation sets and live streams. |

---

##### `<videl-representation>`

**Attributes**

| Attribute | Origin | Description |
|-----------|--------|-------------|
| `id` | manifest | `Representation@id`. Used as the ABR pin target in `forced-rep` and in `videl:representation:switched` event payloads. |
| `bandwidth` | manifest | Declared bitrate in bps. The ABR algorithm selects the highest-bandwidth representation below the current budget. |
| `width` | manifest | Encoded frame width in pixels. Displayed in the quality menu row. |
| `height` | manifest | Encoded frame height in pixels. Displayed as the primary quality label (e.g. `1920×1080`). |
| `mime-type` | manifest | Base MIME type for this representation. May override the adaptation set's `mime-type`. |
| `codecs` | manifest | Codec string. Used to build the `addSourceBuffer` / `changeType` argument. |
| `initialization-url` | manifest (derived) | Absolute URL of the initialization segment (moov box). |
| `initialization-byte-range` | manifest (derived) | Byte range `"start-end"` for the init segment when it shares the media file. Omitted for separate init files. |
| `timestamp-offset` | manifest (computed) | For VOD: `periodStart − presentationTimeOffset / timescale`, applied to `SourceBuffer.timestampOffset` to align decode timestamps. For live: unused (ignored by #startInit); `availability-start-time` is used instead. |
| `segment-template-media` | manifest | Pre-expanded (id, bandwidth) and base-resolved media URL template with `$Number$` / `$Time$` tokens intact. |
| `segment-template-timescale` | manifest | Timescale (ticks per second) for converting `$Time$` values and segment durations. |
| `segment-template-start-number` | manifest | First segment number for `$Number$` expansion (default `1`). |
| `segment-template-pto` | manifest | `SegmentTemplate@presentationTimeOffset` in timescale ticks. |
| `segment-template-duration` | manifest | Fixed segment duration in timescale ticks (the no-`SegmentTimeline` path). |
| `segment-template-timeline` | manifest | JSON-serialised `[{d, r, t?}]` array from `SegmentTimeline/S` elements. |
| `segment-base-url` | manifest | Absolute URL of the media file for SegmentBase addressing. |
| `segment-base-index-range` | manifest | Byte range of the `sidx` box. When present the representation fetches and parses it to discover segment byte ranges. |
| `period-duration` | manifest | Duration of the containing period in seconds. Stamped for SegmentBase representations without a sidx. |
| `live` | manifest | Boolean presence. Present when `MPD@type="dynamic"`. Suppresses `isFullyFetched` and enables live segment updates on each pump tick (appending new segments and expiring old ones from the DVR window). |
| `availability-start-time` | manifest | Unix epoch seconds from `MPD@availabilityStartTime`. Used by ManagedSourceBuffer as the wall-clock timestamp offset for live streams. |
| `time-shift-buffer-depth` | manifest | DVR window depth in seconds (default 0 for pure-live). Defines the range of past segments available for seeking in a live stream. Set by the MPD parser with fallback to player's `time-shift-buffer-depth-default`. |
| `debug` | user config | Enables the visual debug overlay showing id, bandwidth, state, init status, and timeline drift. |
| `videl-state` | internal state | Slot state: `"next"` → `"active"` → absent. |
| `videl-pinned` | internal state | Present when this representation is the ABR-pinned target (`forced-rep` on the parent matches this `id`). Drives the accent border in the quality menu row. |
| `videl-init-appended` | internal state | Present once the initialization segment has been successfully appended. Gates all segment-selection pump walks — no media segments are fetched until this is set. Removed on deactivation and on SourceBuffer reassignment. |

**JavaScript API**

| Member | Type | Description |
|--------|------|-------------|
| `videlUpdate(state)` | `(PlayerState) => void` | Called by the parent adaptation set on each pump tick. Selects and activates the correct segment, extends live segments, and manages the segment prefetch window. |
| `sourceBuffer` | `ISourceBuffer \| null` (get/set) | The SourceBuffer this representation appends into. Setting a new value aborts any in-flight init fetch and resets fetch history and timeline drift. |
| `isFullyFetched` | `boolean` (get) | `true` when the last `<videl-segment>` child has been appended. Always `false` for live representations. |

---

##### `<videl-segment>`

**Attributes**

| Attribute | Origin | Description |
|-----------|--------|-------------|
| `url` | manifest (derived) | Absolute URL of the media segment. Stamped by the parser (SegmentList) or by the representation at activation time (SegmentTemplate / SegmentBase). |
| `byte-range` | manifest (derived) | Optional `"start-end"` byte range sent as an HTTP `Range` header. Absent for full-file segments. |
| `start-time` | manifest (computed) | Segment start time in **wall-clock epoch seconds**. For live, these are epoch-based segment presentation times. For VOD, equals period start time + presentation offset within the period. Used for seek-based segment selection and drift accounting. |
| `duration` | manifest (computed) | Declared duration of this segment in seconds. Used in `isBuffered` tolerance calculation and timeline drift tracking. |
| `debug` | user config | Enables the visual debug block showing state, URL, start time, and duration. |
| `videl-state` | internal state | Slot state: `"next"` (prefetch — fetch bytes into memory) → `"active"` (append bytes to SourceBuffer, fire `videl:done`) → absent (abort in-flight fetch). |

**JavaScript API**

| Member | Type | Description |
|--------|------|-------------|
| `sourceBuffer` | `ISourceBuffer \| null` | The SourceBuffer to append into. Must be set by the parent representation before `videl-state` becomes `"active"`. |

---

#### Events

`<videl-player>` surfaces all internal activity through bubbling custom events:

| Event | Detail | Fired by |
|-------|--------|---------|
| `videl:done` | `{ startTime, duration, bytes, fetchMs }` | `<videl-segment>` on successful append |
| `videl:done` | `{ periodId }` | `<videl-period>` on period end |
| `videl:done` | `{ src }` | `<videl-player>` dispatched on the active `<videl-presentation>` when the `<video>` element fires `ended` (after `endOfStream`, all buffered content rendered) |
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
| `fetch` | Network requests for init and media segments; live segment updates (appends and expirations) |
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

#### DRM — Encrypted Media Extensions

Videl supports Widevine, PlayReady, FairPlay, and ClearKey protected DASH content via the [Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media/) API. DRM is configured exclusively through JavaScript properties — there are no DRM attributes — because the configuration surface includes non-serializable callbacks (`parseLicenseResponse`, `requestFilter`, `initDataTransform`).

##### Configuration scope

DRM config can be set at two levels. The player checks them in order:

1. **`presentation.drmConfig`** — per-presentation override (set in a `videl:before-activate` handler)
2. **`player.drmConfig`** — player-wide default (used when the presentation has no override)

##### `videl:before-activate`

Every videl element dispatches `videl:before-activate` immediately before its `videl-state` transitions to `"active"`. The event carries a `waitUntil(promise)` method modeled on the Service Worker `ExtendableEvent` — the element waits for all registered promises to resolve before proceeding. This is the correct place to perform any async setup (token fetches, DRM config) that must complete before activation.

```js
player.addEventListener('videl:before-activate', (event) => {
  const { element } = event.detail;
  // element is the element about to become active —
  // videl-player, videl-presentation, videl-period, or videl-adaptation-set
});
```

The event fires on **every** element type in the hierarchy but activation of child elements is independent — listening on `<videl-player>` catches all of them via bubbling. Filter by `element.tagName` to target the right level.

`videl:before-activate` does **not** fire for `videl-state="next"` (prefetch). Only the `"active"` transition triggers it.

---

##### Single stream — player-level config

The simplest case: one stream, one license server. Set `drmConfig` before `src`.

```js
const player = document.querySelector('videl-player');

player.drmConfig = {
  'com.widevine.alpha': {
    serverUrl: 'https://license.example.com/widevine'
  }
};

player.src = 'https://cdn.example.com/stream.mpd';
```

---

##### Playlist — per-presentation config via `videl:before-activate`

In playlist mode each `<videl-presentation>` activates in turn. Set DRM config on the individual element inside a `videl:before-activate` handler so each presentation carries its own license server credentials. The handler is also the right place to fetch a short-lived auth token, because `event.waitUntil()` holds activation until the fetch completes.

```js
player.addEventListener('videl:before-activate', (event) => {
  const { element } = event.detail;

  if (element.tagName !== 'VIDEL-PRESENTATION') return;

  event.waitUntil(
    fetch('/auth/license-token', { method: 'POST' })
      .then(r => r.json())
      .then(({ token }) => {
        element.drmConfig = {
          'com.widevine.alpha': {
            serverUrl: 'https://license.example.com/widevine',
            httpRequestHeaders: { Authorization: `Bearer ${token}` }
          }
        };
      })
  );
});
```

```html
<videl-player>
  <videl-presentation src="ep1.mpd">…</videl-presentation>
  <videl-presentation src="ep2.mpd">…</videl-presentation>
</videl-player>
```

The player will not call `#video.play()` or proceed with MSE setup until every `waitUntil` promise resolves. If the promise rejects, `videl:activate:error` fires on the element and activation is aborted.

---

##### `DrmSystemConfig` reference

All fields are optional. Use only those required for your provider.

| Field | Type | Description |
|---|---|---|
| `serverUrl` | `string` | License server URL. Omit only for ClearKey with inline `keys`. |
| `httpRequestHeaders` | `Record<string, string>` | HTTP headers sent with every license request (e.g. `Authorization`). |
| `httpTimeout` | `number` | License request timeout in milliseconds. |
| `certificateUrl` | `string` | **FairPlay only.** URL of the server certificate (DER-encoded). Player fetches it automatically before the first session. |
| `certificate` | `Uint8Array` | **FairPlay only.** Pre-fetched server certificate. Takes precedence over `certificateUrl`. |
| `initDataTransform` | `(initData, initDataType, cert) => Uint8Array \| Promise<Uint8Array>` | **FairPlay only.** Override the default `skd://` envelope builder when the provider uses a non-standard contentId format. |
| `parseLicenseResponse` | `(responseBody: ArrayBuffer) => ArrayBuffer \| Promise<ArrayBuffer>` | Decode the raw HTTP response body into key bytes. Default: pass-through (binary). Override for base64 or JSON-wrapped responses. |
| `requestFilter` | `(request: { url, headers, body }) => void \| Promise<void>` | Mutate the outgoing license request in-place before it is sent. |
| `keys` | `Record<string, string>` | **ClearKey only.** Inline key map (`keyIdHex → keyHex`). No license server needed when this is provided. |

`DrmConfig` is `Record<string, DrmSystemConfig>` — a map of EME key system string to config.

---

##### Widevine

```js
player.drmConfig = {
  'com.widevine.alpha': {
    serverUrl: 'https://license.example.com/widevine',
    httpRequestHeaders: {
      'Authorization': 'Bearer <token>'
    }
  }
};
```

With a JSON-wrapped license response (common with proxy servers):

```js
player.drmConfig = {
  'com.widevine.alpha': {
    serverUrl: 'https://license.example.com/widevine',
    parseLicenseResponse: async (body) => {
      const { license } = JSON.parse(new TextDecoder().decode(body));
      return Uint8Array.from(atob(license), c => c.charCodeAt(0)).buffer;
    }
  }
};
```

---

##### PlayReady

```js
player.drmConfig = {
  'com.microsoft.playready': {
    serverUrl: 'https://license.example.com/playready'
  }
};
```

---

##### FairPlay (Safari)

FairPlay requires a server certificate and may require a custom `initDataTransform` when the provider uses a non-standard `skd://` format.

```js
player.drmConfig = {
  'com.apple.fps': {
    serverUrl:      'https://license.example.com/fairplay',
    certificateUrl: 'https://cdn.example.com/fps-cert.cer',

    // Provider returns base64-encoded CKC — decode it before session.update()
    parseLicenseResponse: async (body) => {
      const b64 = new TextDecoder().decode(body);
      return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
    }
  }
};
```

When the provider uses a non-`skd://` contentId format, override `initDataTransform`:

```js
player.drmConfig = {
  'com.apple.fps': {
    serverUrl:      'https://license.example.com/fairplay',
    certificateUrl: 'https://cdn.example.com/fps-cert.cer',

    // Custom contentId extraction — e.g. provider sends a raw UUID blob
    initDataTransform: (initData, initDataType, cert) => {
      const contentId = extractContentIdFromBlob(initData);
      return buildFairPlayEnvelope(initData, contentId, cert);
    },

    parseLicenseResponse: async (body) => {
      const { ckc } = JSON.parse(new TextDecoder().decode(body));
      return Uint8Array.from(atob(ckc), c => c.charCodeAt(0)).buffer;
    }
  }
};
```

The default `initDataTransform` (used when none is provided) treats initData as a UTF-8 `skd://` URL and builds Apple's standard binary envelope. Override only when the provider deviates from this.

---

##### ClearKey

ClearKey is a W3C-standardised key system that works without a license server. Provide key IDs and their corresponding keys in hex:

```js
player.drmConfig = {
  'org.w3.clearkey': {
    keys: {
      '6935b4a2f7a5bd8a6bca38e1e2c9dbb1': '6fc1e5c3f6eb28e04db86c07b7e3f87e'
    }
  }
};
```

For a ClearKey server (useful for testing infrastructure):

```js
player.drmConfig = {
  'org.w3.clearkey': {
    serverUrl: 'https://clearkey.example.com/license'
  }
};
```

---

##### Mixed key systems in a playlist

Different presentations in a playlist can use different key systems. The lookup order (presentation config → player config) makes this straightforward:

```js
// Player-wide Widevine default for most presentations
player.drmConfig = {
  'com.widevine.alpha': {
    serverUrl: 'https://license.example.com/widevine'
  }
};

// Override just the FairPlay presentation
player.addEventListener('videl:before-activate', (event) => {
  const { element } = event.detail;
  if (element.tagName !== 'VIDEL-PRESENTATION') return;
  if (element.getAttribute('src')?.includes('fairplay')) {
    element.drmConfig = {
      'com.apple.fps': {
        serverUrl:      'https://license.example.com/fairplay',
        certificateUrl: 'https://cdn.example.com/fps-cert.cer'
      }
    };
  }
});
```

---

##### DRM events

| Event | Detail | When |
|---|---|---|
| `videl:before-activate` | `{ element }` | Any element is about to become active. Use `event.waitUntil(promise)` to delay activation. |
| `videl:activate:error` | `{ element, error }` | A `waitUntil` promise rejected, or activation setup failed. `videl-state` is reverted. |
| `videl:drm:ready` | `{ keySystem: string }` | `MediaKeys` created and set on the video element. |
| `videl:drm:session-created` | `{ sessionId: string }` | A new EME key session was created. |
| `videl:drm:error` | `{ error: Error }` | Key system access failed, license request failed, or `session.update()` rejected. |

---

#### License

[MIT](LICENSE) © 2026 Jon-Carlos Rivera
