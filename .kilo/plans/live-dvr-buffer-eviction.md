# Live-DVR Buffer Eviction

**Date:** 2026-06-09

## Root Cause

`video.seekable` is the **union** of:
1. The range set by `MediaSource.setLiveSeekableRange(start, end)`, and
2. All currently-buffered ranges in the source buffers.

`#updateLiveSeekableRange` correctly slides the seekable window forward via `setLiveSeekableRange` each tick. However, old buffered media is never removed from the `ManagedSourceBuffer` instances. Because that old content (from player-time `0` onward) is always buffered, the browser's union forces `video.seekable.start(0) = 0` regardless of what `setLiveSeekableRange` says. This makes `seekableStart` constant and `seekableEnd` grow — the DVR window expands instead of sliding.

ADR-0005 §"Multi-Period Behaviour" already notes the intended behaviour:
> "Eviction also `remove()`s the corresponding buffered range from the shared SourceBuffers behind `seekableStart` (see ADR-0001 eviction horizon — for live-dvr the horizon is `seekableStart`, not a fixed 30 s)."

This was never implemented.

## Fix

Add live-buffer eviction to `videl-player.#updateLiveSeekableRange()`. On every pump tick where TSBD > 0, after updating the seekable range, call `remove(wallAnchor, dvrStart)` on every active `ManagedSourceBuffer`:

- `wallAnchor` = wall-clock epoch second of player-time 0 (earliest possible buffered content).
- `dvrStart` = `nowSec − tsbd` (wall-clock DVR window trailing edge, same value already computed for `setLiveSeekableRange`).

`ManagedSourceBuffer.remove` accepts wall-clock values and translates them to player-time internally (subtracts `wallAnchor`), consistent with the ergo-mse wall-clock-native API contract.

The remove call is async (queued by `ManagedSourceBuffer`). Errors are suppressed with `.catch(() => {})`, matching the existing pattern in `videl-period.ts:288`.

### Throttle guard

Calling `remove` on an already-empty range every 250 ms is harmless but wasteful. Only issue the call when `dvrStart > this.#wallAnchor + 0.5` — i.e., there is at least 0.5 s of evictable content before the DVR window start.

## Changes Required

### `src/elements/videl-player.ts` — `#updateLiveSeekableRange()`

After the existing `ms.setLiveSeekableRange(...)` call, append:

```typescript
// Evict buffered content behind the DVR window trailing edge so that
// video.seekable (which is the union of buffered + setLiveSeekableRange)
// slides correctly instead of growing from the origin (ADR-0005).
const evictTo = Math.max(this.#wallAnchor, start); // wall-clock dvrStart
if (evictTo > this.#wallAnchor + 0.5) {
  for (const msb of this.#sourceBuffers.values()) {
    msb.remove(this.#wallAnchor, evictTo).catch(() => {});
  }
}
```

`start` is already `nowSec - tsbd` (wall-clock), computed just above for `setLiveSeekableRange`.

## Scope of `#sourceBuffers`

`this.#sourceBuffers` is a `Map<string, ISourceBuffer>` holding:
- `'video'` → `ManagedSourceBuffer`
- `'audio'` → `ManagedSourceBuffer`
- `'text'` → `TextSourceBuffer` (when text tracks are active)
- `'event-stream'` → `EventSourceBuffer` (when `<videl-event-stream>` elements exist)

All four implement `ISourceBuffer.remove(wallStart, wallEnd)` with wall-clock translation internally. Iterating `this.#sourceBuffers.values()` covers all of them — no special-casing needed.

## What Does NOT Change

- `setLiveSeekableRange` call — already correct.
- `wallAnchor` computation — already correct.
- `#updateLivePeriodWindows` — already correct, just wasn't receiving a sliding `seekableStart`.
- The `videl-period.ts` render-guard fix (previous session) — still needed and orthogonal.

## Verification

After the fix, on a live-dvr stream:
- `video.seekable.start(0)` should advance ~1 tick behind `nowSec − tsbd`.
- `seekableStart` in `PlayerState` should slide forward at 1:1 rate with wall clock.
- `visDur` in `#updateLivePeriodWindows` = `seekableEnd − seekableStart ≈ tsbd` (constant).
- Period `flex-grow` stays constant, not growing.
