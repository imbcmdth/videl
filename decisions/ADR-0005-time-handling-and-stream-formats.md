# ADR-0005: Time Handling Across Stream Formats (live / live-dvr / vod)

**Date:** 2026-06-07
**Status:** Accepted
**Deciders:** imbcmdth, project contributors

---

## Context

Three MSE/DOM quantities govern where content sits on the timeline and what the
user can do with the scrubber:

- **`MediaSource.duration`** — the declared length of the presentation. Bounds
  what the browser will expose as seekable for a non-live stream.
- **`SourceBuffer.timestampOffset`** — added to each appended sample's decode
  time to map media-timeline time onto presentation time (`video.currentTime`).
- **The seekable range** — for VOD this is derived by the browser from
  `duration` + buffered data; for live it is set explicitly via
  `MediaSource.setLiveSeekableRange(start, end)`.

These interact differently across the three stream formats videl supports, and
getting any one of them wrong produces a distinct, hard-to-diagnose class of bug
(seekbar that grows as you watch, forward seeks that clamp to the buffered edge,
`currentTime` in the billions, a DVR window that never slides, periods that
linger after they have fallen out of the time-shift buffer).

Prior to this ADR the rules were implicit and partially contradictory:

- `MediaSource.duration` was set to `Infinity` for live but left **unset** for
  VOD, so `video.seekable` for VOD only ever covered the buffered region — the
  seekbar appeared to grow and forward seeks clamped to the buffered edge.
- The seek range in `videl-presentation` trusted `video.seekable` whenever it
  was non-zero, regardless of format, defeating the manifest-duration fallback.
- "No `timeShiftBufferDepth`" was handled with a magic `30`-second default in
  some paths and `0` in others.
- Multi-period window eviction (periods falling out of the DVR window) had no
  defined behaviour at all.

This ADR fixes the taxonomy so every time-related change has one correct place
to look.

---

## Format Taxonomy

videl recognises exactly three playback formats, derived from the MPD plus one
player-level configuration attribute.

| Format     | MPD signal                                                                 | DVR window        | Seekbar |
|------------|----------------------------------------------------------------------------|-------------------|---------|
| **vod**      | `MPD@type="static"`                                                        | n/a (whole asset) | full, fixed |
| **live**     | `MPD@type="dynamic"` **and** effective `timeShiftBufferDepth == 0`         | none (edge only)  | hidden |
| **live-dvr** | `MPD@type="dynamic"` **and** effective `timeShiftBufferDepth > 0`          | sliding, fixed width | fixed width, sliding scrubber |

### Effective `timeShiftBufferDepth` and the spec divergence

Per ISO/IEC 23009-1:2022 §5.3.1.2 (Table — `MPD@timeShiftBufferDepth`):

> "When not present, the value is infinite. This value of the attribute is
> undefined if the type attribute is equal to 'static'."

The literal spec default for an absent `timeShiftBufferDepth` on a dynamic MPD is
therefore **infinite** (seekable all the way back to `availabilityStartTime`),
**not** zero. videl deliberately diverges from this default for product reasons:
an unbounded, ever-growing DVR window is rarely what an operator wants and is
expensive to keep in the DOM/buffer.

**Decision — `time-shift-buffer-depth-default` attribute.** `<videl-player>`
accepts a `time-shift-buffer-depth-default` attribute (seconds, default `0`).
When a dynamic MPD omits `timeShiftBufferDepth`, the parser substitutes this
default as the **effective** `timeShiftBufferDepth`.

- Default (`0`) → absent `timeShiftBufferDepth` behaves as **live** (no window,
  seekbar hidden, content mapped at time 0). This matches the product model.
- An operator wanting spec-like behaviour sets a large value (e.g.
  `time-shift-buffer-depth-default="86400"`) to emulate "effectively infinite",
  or any finite window they prefer.

The effective value (never the raw absent state) is what gets stamped on the
representation as `time-shift-buffer-depth` and what every downstream
computation reads. A genuine `timeShiftBufferDepth="PT0S"` in the manifest is
indistinguishable from an absent one resolved to the default of `0` — both mean
**live**, which is the intended equivalence.

---

## Decision — Per-Format Primitive Settings

The single source of truth. Every time-handling code path must conform to this
table.

| Quantity | **vod** | **live** | **live-dvr** |
|----------|---------|----------|--------------|
| `MediaSource.duration` | `mediaPresentationDuration` (finite) | `Infinity` | `Infinity` |
| `SourceBuffer.timestampOffset` | `periodStart − pto/timescale` (per representation) | `availStart − now` (maps live edge → `currentTime ≈ 0`) | `availStart + TSBD − now` (maps DVR start → `currentTime = 0`, edge → `TSBD`) |
| Seekable range source | browser-derived from `duration` | none set (`setLiveSeekableRange` skipped) | `setLiveSeekableRange(liveEdge − TSBD, liveEdge)` each tick |
| `seekableStart` used by UI | `0` | n/a (no seekbar) | `liveEdge − TSBD` (slides) |
| `seekableEnd` used by UI | `mediaPresentationDuration` | n/a (no seekbar) | `liveEdge` (slides) |
| `endOfStream()` | called once buffered reaches duration | never | never |
| Seekbar (`videl-presentation`) | full width, fixed | **hidden** (`no-seek`) | fixed width = `TSBD`, scrubber tracks position in window |
| `no-seek` attribute on presentation | absent | **present** | absent |

### Why VOD must set a finite `MediaSource.duration`

This is the core fix motivating the ADR. With `MediaSource.duration` left
unset/`NaN`, `video.seekable` for a VOD MSE stream only spans the **buffered**
range and grows as segments append. Two visible symptoms result:

1. The seekbar appears to lengthen as playback proceeds.
2. Forward seeks past the buffered edge are clamped by the browser to
   `seekable.end(...)`, so clicking ahead jumps to the end of buffered content
   instead of the absolute target time. (Backward seeks always work because
   the target is already inside the buffered/seekable range.)

Setting `MediaSource.duration = mediaPresentationDuration` once at `sourceopen`
makes `video.seekable` span `[0, duration]` immediately, so both the seekbar and
forward seeking use absolute presentation time.

### UI seek range must be format-aware, not "trust seekable if non-zero"

`video.seekable` is only authoritative for **live-dvr** (where we explicitly set
it). For VOD the manifest duration is authoritative; for live there is no
seekbar. Therefore `videl-presentation` computes its seek range as:

- **vod / live:** `seekEnd = mediaPresentationDuration ?? duration`, `seekStart = 0`.
- **live-dvr:** `seekStart = seekableStart`, `seekEnd = seekableEnd` (the values
  pushed each pump tick from `video.seekable`).

Both `render()` (visual track + scrubber position) and `#onSeekInput()`
(scrubber → absolute time) must use the **same** format-aware computation, or
dragging the scrubber will map to a different range than the one drawn.

---

## Decision — Unified Wall-Clock Time Coordinate System

All times in the component tree (segment `startTime`, period `start`, `currentWallTime`
in `PlayerState`) are expressed in **wall-clock epoch seconds**. Only `videl-player`
and `ManagedSourceBuffer`/`TextSourceBuffer` know how to translate between wall-clock
and the browser's `video.currentTime` (player-time) space.

### Core invariant

```
wallAnchor     =  wall-clock epoch second at video.currentTime = 0
currentWallTime  =  video.currentTime + wallAnchor
```

`wallAnchor` is computed once by `videl-player` at `sourceopen` and stamped on
every `ISourceBuffer` instance. Components below the player receive it via
`PlayerState.wallAnchor` and never need to compute it themselves.

| Format | `wallAnchor` |
|--------|-------------|
| vod | `0` (identity — epoch seconds equal currentTime) |
| live | `activationNow` (live edge ≈ currentTime 0) |
| live-dvr | `activationNow − TSBD` (DVR window start = currentTime 0) |

### `PlayerState` time fields

| Field | Space | Notes |
|-------|-------|-------|
| `currentWallTime` | wall-clock epoch seconds | **Primary.** All component logic. |
| `currentTime` | player-time (video.currentTime) | **Deprecated.** Logging + UI display vs. `video.seekable` only. |
| `wallAnchor` | wall-clock epoch seconds | Constant for the lifetime of the active presentation. |
| `buffered` | wall-clock epoch seconds | `OffsetTimeRanges(video.buffered, wallAnchor)`. |
| `sourceBuffered` | wall-clock epoch seconds | Each entry from `ManagedSourceBuffer.buffered` (+wallAnchor). |

### `ISourceBuffer` wall-clock interface

Callers (videl-representation, videl-period) pass all time values in **wall-clock
epoch seconds**. `ManagedSourceBuffer` and `TextSourceBuffer` subtract `wallAnchor`
before applying them to the browser's SourceBuffer or TextTrack (which work in
player-time), and add `wallAnchor` to `buffered` ranges on the way out.

| Property / method | Caller value | Implementation |
|---|---|---|
| `timestampOffset` (set) | wall-clock epoch offset | subtracts `wallAnchor` → actual `SourceBuffer.timestampOffset` |
| `remove(start, end)` | wall-clock epoch seconds | subtracts `wallAnchor` from both arguments |
| `appendWindowStart/End` (set) | wall-clock epoch seconds | subtracts `wallAnchor` |
| `buffered` (get) | — | returns `OffsetTimeRanges(inner, +wallAnchor)` |
| `mode` | — | pass-through, no translation |

### Period `start` in the DOM

The MPD parser stamps **wall-clock epoch seconds** as the `start` attribute on
`<videl-period>` elements for live streams:

```
period.start = availabilityStartTime + Period@start_duration_offset
```

For VOD, `wallAnchor = 0` so `period.start = 0 + offset = offset` — unchanged from
the prior behaviour. This is the one place where the parser behaves differently for
live vs VOD.

---

## Decision — `timestampOffset` Derivations

The math is unchanged from the original ADR. What changed is **who computes it**
and **in what space callers express it**.

Callers (videl-representation `#startInit`) pass a **wall-clock** offset to
`ISourceBuffer.timestampOffset`. `ManagedSourceBuffer` subtracts `wallAnchor` to
produce the actual `SourceBuffer.timestampOffset`:

```
actual SourceBuffer.timestampOffset = wallOffset − wallAnchor
```

**vod** (and any stream with non-zero `@presentationTimeOffset`):
```
wallOffset = periodStart − presentationTimeOffset / timescale
wallAnchor = 0
actual     = wallOffset − 0 = periodStart − pto/timescale   (unchanged)
```
Stamped by the parser as `timestamp-offset` on each representation; read and passed
to `ISourceBuffer.timestampOffset` in `#startInit`.

**live** (effective `TSBD == 0`):
```
wallOffset = availabilityStartTime
wallAnchor = activationNow
actual     = availStart − activationNow
```
Maps the live edge to `currentTime ≈ 0`.

**live-dvr** (effective `TSBD > 0`):
```
wallOffset = availabilityStartTime
wallAnchor = activationNow − TSBD
actual     = availStart − (activationNow − TSBD)
           = availStart + TSBD − activationNow          (same formula as before)
```
Maps the DVR-window start to `currentTime = 0`, live edge to `currentTime = TSBD`.

`wallOffset` (= `availabilityStartTime`) is read from the `availability-start-time`
attribute in `#startInit` for live streams. Computed **once** on first activation.
Never recomputed — the window slides via `setLiveSeekableRange`.

---

## Decision — Live Seekable Window Maintenance

For **live-dvr** only, `<videl-player>` calls `setLiveSeekableRange` on every
pump tick using `wallAnchor` (no longer reaching into a child representation):

```
nowSec   = Date.now() / 1000
liveEdge = nowSec − wallAnchor   (player-time)
start    = liveEdge − TSBD
setLiveSeekableRange(max(0, start), liveEdge)
```

At activation: `liveEdge = activationNow − (activationNow − TSBD) = TSBD`. As
wall clock advances, `liveEdge` grows at 1:1 rate. Identical result to the prior
formula; simpler access (no child DOM query needed).

For **live** (`TSBD == 0`) the call is skipped entirely — there is no window to
maintain and no seekbar to feed. For **vod** the browser derives the range from
`duration`; `setLiveSeekableRange` is never used.

---

## Decision — Multi-Period Behaviour

Periods are DOM elements (`<videl-period>`) that double as the visual seekbar
segments (self-assigned `slot="seek"`, `flex-grow = duration`). Their lifecycle
differs by format.

### vod

Static set of periods, fixed `start`/`duration`. No eviction. Each period's
seekbar segment has constant width. A period fires `videl:done` when its media
adaptation sets finish or the playhead passes `start + duration`
(`videl-period.videlUpdate`).

### live / live-dvr — period state machine

Periods are open-ended at the live edge: the **current** period has
`duration = null` (it never fires `videl:done`; see
`videl-period.videlUpdate`). Earlier periods in a multi-period dynamic MPD have
concrete `start`/`duration`.

**Window eviction (live-dvr).** As wall clock advances, the DVR window
(`[seekableStart, seekableEnd]`) slides forward. A past period *falls out of the
window* once its entire span is behind the window start:

```
period.start + period.duration < seekableStart   →   evict
```

On eviction the period element is **removed from the DOM**. This is the only
correct trigger — removing earlier (e.g. as soon as it stops being active) would
break DVR seek-back into that period; removing later leaks DOM and buffered
media. Eviction also `remove()`s the corresponding buffered range from the
shared SourceBuffers behind `seekableStart` (see ADR-0001 eviction horizon — for
live-dvr the horizon is `seekableStart`, not a fixed 30 s).

**live (`TSBD == 0`)** has no window, so there is nothing to seek back into;
past periods are evicted as soon as the playhead leaves them (their buffered
media is trimmed behind `currentTime`). The seekbar is hidden so no visual
adjustment is needed.

### Seekbar segment adjustment (live-dvr)

Because the window has fixed width but periods have fixed absolute
`start`/`duration`, a period straddling the trailing edge of the window must
have its **visible** extent clamped to the window, not its absolute extent:

- A period's visible seekbar width is proportional to
  `min(period.start + period.duration, seekableEnd) − max(period.start, seekableStart)`,
  i.e. the intersection of the period with the current window — **not** the raw
  `duration`.
- This is recomputed on the pump tick (the window slides every tick), so the
  oldest visible period appears to shrink as it approaches `seekableStart`,
  until it is fully evicted and removed.
- `flex-grow` is therefore driven by the **windowed** duration for dynamic
  streams, and by the raw `duration` for static streams.

Invariant: **the total seekbar width is constant for live-dvr** — periods shrink
and disappear at the trailing edge while the current open-ended period grows at
the leading edge, summing to a fixed `TSBD`.

---

## Detection / Wiring Summary

| Decision point | Mechanism |
|----------------|-----------|
| Format detection | `MPD@type` + effective `timeShiftBufferDepth` (parser) |
| `time-shift-buffer-depth-default` | attribute on `<videl-player>`, applied by parser when `timeShiftBufferDepth` absent |
| Per-representation live metadata | `live`, `availability-start-time`, `time-shift-buffer-depth` attributes stamped by parser |
| `no-seek` on presentation | stamped by parser when dynamic **and** effective `TSBD == 0` |
| `MediaSource.duration` | set at `sourceopen` in `videl-player` — finite for vod, `Infinity` for live/live-dvr |
| `wallAnchor` | computed by `videl-player` at `sourceopen`; stamped on every `ISourceBuffer`; propagated via `PlayerState` |
| `timestampOffset` | caller (videl-representation `#startInit`) passes wall-clock value; `ManagedSourceBuffer`/`TextSourceBuffer` subtract `wallAnchor` |
| Period `start` attribute | parser stamps wall-clock epoch seconds for live (`availStart + offset`); presentation-relative seconds for VOD |
| Seekable window | `videl-player.#updateLiveSeekableRange` using `wallAnchor` directly (live-dvr only) |
| UI seek range | `videl-presentation.render` + `#onSeekInput`, format-aware; uses `state.currentTime` (player-time) vs `seekableStart/End` |
| Seekbar visibility | `:host([no-seek]) .seek-row { display: none }` |
| Period eviction / segment adjustment | per pump tick, keyed on `seekableStart`/`seekableEnd` |

---

## Invariants

1. **One source of truth.** Format is decided once, in the parser, and expressed
   as DOM attributes. No element below the parser re-derives format from
   heuristics other than reading those attributes.
2. **VOD always has a finite `MediaSource.duration`.** Never rely on
   `video.seekable` to discover VOD length.
3. **`video.seekable` is authoritative only for live-dvr.** vod uses manifest
   duration; live has no seekbar.
4. **`render()` and `#onSeekInput()` use identical seek-range math.** The drawn
   range and the interactive range must never diverge.
5. **`wallAnchor` is computed once per presentation**, at `sourceopen`; never
   recomputed. All `ISourceBuffer` instances and `PlayerState` share the same value.
6. **All component-tree times are wall-clock epoch seconds.** Segment `startTime`,
   period `start`, `currentWallTime` — one coordinate system. `video.currentTime`
   (player-time) is only used by the UI scrubber and MSE API calls.
7. **`ISourceBuffer` callers pass wall-clock values**; implementations translate
   internally. No caller below `videl-player` needs to know `wallAnchor`.
8. **`timestampOffset` is applied once per activation**, before the init append;
   the window slides via `setLiveSeekableRange`, never by re-offsetting.
9. **live-dvr seekbar width is constant.** Period eviction at the trailing edge
   balances growth of the open-ended period at the leading edge.
10. **A period is removed from the DOM iff `start + duration < seekableStart`**
    (live-dvr) — the single eviction trigger.

---

## Consequences

**Positive**
- Every time-related bug now has one table row and one file to consult.
- VOD seekbar is full-width and stable; forward seeking uses absolute time.
- live hides the scrubber and starts at 0 with no special per-stream config.
- live-dvr presents a stable fixed-width window with a sliding scrubber, and
  multi-period DVR back-seek works because eviction is deferred to window exit.
- The spec divergence is explicit and overridable via
  `time-shift-buffer-depth-default`.

**Negative / Trade-offs**
- Diverges from the ISO default (absent `timeShiftBufferDepth` → infinite). This
  is a deliberate, documented product choice mitigated by the configurable
  default.
- Windowed seekbar width and period eviction add per-tick computation to
  `videl-presentation`/`videl-period`. Cost is negligible at the 250 ms tick.
- A genuine `timeShiftBufferDepth="PT0S"` cannot be distinguished from "absent,
  default 0" — both are treated as live. Accepted as the intended equivalence.

---

## Rejected Alternatives

**Treat absent `timeShiftBufferDepth` as infinite (spec-literal).** Rejected as
the *default* because an unbounded growing window is rarely the desired product
behaviour and is costly in DOM/buffer. Preserved as an opt-in via a large
`time-shift-buffer-depth-default`.

**Trust `video.seekable` uniformly for the UI seek range.** This is exactly the
prior bug — `video.seekable` reflects only buffered data for VOD and grows over
time. Rejected in favour of format-aware range computation.

**Set `MediaSource.duration = Infinity` for VOD as well and lean on
`setLiveSeekableRange`.** Would make VOD seek math mirror live, but breaks
native end-of-stream handling, the `ended` event, and `videl:done` playlist
advancement, all of which depend on a finite duration. Rejected.

**Recompute `timestampOffset` each tick to "follow" the live edge.** Would
re-map already-buffered media and corrupt the timeline. The sliding window is a
`setLiveSeekableRange` concern only. Rejected.

**Evict past periods as soon as they stop being active.** Breaks DVR back-seek
into recent periods. Rejected in favour of the `start + duration < seekableStart`
trigger.

---

## References

- ISO/IEC 23009-1:2022 (5th ed.) §5.3.1 — `MPD@type`, `@availabilityStartTime`,
  `@timeShiftBufferDepth` (local copy:
  `.kilo/info/ISO_IEC 23009-1_2022 ed.5 - id.83314 Publication PDF (en).md`,
  see Table at line 1228 and the Partially Unavailable Period definition at
  line 1549).
- [MDN: MediaSource.setLiveSeekableRange](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/setLiveSeekableRange)
- [MDN: MediaSource.duration](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/duration)
- [MDN: SourceBuffer.timestampOffset](https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/timestampOffset)
- [ADR-0001](./ADR-0001-mse-ownership-and-lifecycle.md) — MSE ownership,
  SourceBuffer lifecycle, eviction horizon.
- [ADR-0002](./ADR-0002-attribute-state-vs-slot-state.md) — attribute-vs-slot
  state (periods self-assign `slot="seek"` for layout, separate from playback
  state).
- [ADR-0004](./ADR-0004-text-source-buffer.md) — `timestampOffset` application
  for text cues.
