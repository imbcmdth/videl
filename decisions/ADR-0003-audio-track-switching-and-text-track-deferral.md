# ADR-0003: Audio Track Switching Architecture and Text Track Deferral

**Date:** 2026-06-05  
**Status:** Accepted  
**Deciders:** Project contributors

---

## Context

### Multi-track DASH streams

DASH manifests routinely expose multiple `AdaptationSet` elements for audio — one per language or audio description variant — and one or more `AdaptationSet` elements for text (subtitles, captions). All adaptation sets of the same content type share a single `SourceBuffer` via the player's content-type keyed map (`Map<string, ManagedSourceBuffer>`).

Two related questions arose during implementation:

1. **Audio track switching** — how should the user be able to switch between audio languages at runtime, and what does the player need to do to make the new track start from the current playhead position rather than the end of the already-buffered audio?
2. **Text tracks** — why are text adaptation sets skipped entirely, and what would be required to support them?

---

## Audio Track Switching

### The problem: shared SourceBuffer and buffered-ahead audio

When the active audio `AdaptationSet` is switched, the new adaptation set inherits the same `ManagedSourceBuffer` that the old one was writing to. The representation inside the new adaptation set runs `videlUpdate` on the next pump tick and immediately checks `bufferedAhead(currentTime, sbBuffered)`. Because the old audio track has already filled the buffer ahead of `currentTime`, `bufferedAhead` returns a large positive value and the representation concludes there is nothing to fetch — the new language audio never arrives.

Without intervention, switching audio tracks produces silence (or continued playback of the old language) until the buffer naturally drains past `currentTime`.

### Decision: trim the SourceBuffer before activating the new ADS

When the user selects a new audio adaptation set, the period element performs the switch in the following order:

1. **Trim the audio SourceBuffer** — call `sourceBuffer.remove(currentTime, Infinity)` on the *currently active* audio ADS's source buffer. This is queued as operation 1 in the `ManagedSourceBuffer` serialisation queue.
2. **Activate the new audio ADS** — `PickNMixin.activateChild(newAds)` deactivates the old ADS (and cascades deactivation to its active representation) and sets `videl-state="active"` on the new ADS.
3. The new ADS distributes the same `ManagedSourceBuffer` reference to its representations.
4. On the next pump tick, the new representation calls `#startInit()` which appends the new codec's init segment — queued as operation 2, after the remove.
5. The `ManagedSourceBuffer` drains in order: remove → init append → media segments from `currentTime`.

Because all operations are serialised through the MSB queue, there is no race: the old audio data is always removed before the new track's init segment is written.

### Implementation

The period element (`videl-period.ts`) owns the switch logic:

- It stores `#lastCurrentTime` on every `videlUpdate` call so the value is available synchronously when the click event fires.
- It registers a `videl:track:select` listener on itself in `connectedCallback`.
- The handler verifies the event originates from a direct child ADS of this period with `content-type="audio"`, then performs the trim + activate sequence described above.

The audio ADS (`videl-adaptation-set.ts`) fires `videl:track:select` (composed, bubbling) from its `.track` row click handler. Inactive audio track rows render with `cursor: pointer`; the active row is non-interactive.

### Why the period owns the switch, not the adaptation set

The period has two things the adaptation set does not:

- **`#lastCurrentTime`** — the playhead position needed to determine where to start the trim.
- **Authority over which adaptation set is active** — `PickNMixin.activateChild` is a method of the period's mixin stack, not the adaptation set's.

The adaptation set's job is limited to signalling user intent upward; the period performs the actual state transition.

---

## Video Quality Locking

In addition to audio track switching, user interaction on the video quality menu was also implemented at the same time, as it shares the same event and element infrastructure.

Left-clicking a `<videl-representation>` row pins that representation and disables ABR for the adaptation set:

- A `forced-rep` attribute is set on the `<videl-adaptation-set>` containing the clicked representation's ID.
- `#selectRepresentation` checks `forcedRepId` before running the bandwidth-based ABR algorithm. If the forced representation exists in the current child list, it is returned unconditionally.
- A `pinned` boolean attribute is stamped on the forced representation element (and removed from all others) so the render layer can show a visual indicator (`⚲` + accent border).
- If the forced representation is subsequently removed from the DOM (right-click → remove), `forced-rep` is cleared and ABR resumes automatically.

Right-clicking a representation removes it from the DOM entirely (permanently reducing the available quality levels for the current stream). `preventDefault()` suppresses the browser context menu. If the removed representation was active, `videlUpdate` is called immediately with the last known `PlayerState` so ABR selects a replacement without waiting for the next pump tick.

---

## Text Track Deferral

### Current behaviour

The period's `#activateAll` and `#preloadAll` methods explicitly skip adaptation sets with `content-type="text"`:

```typescript
if (contentType === 'text') continue;
```

No `SourceBuffer` is created for text content, and text adaptation sets are never assigned `videl-state="active"`.

### Why text tracks are deferred

MSE (`MediaSource` / `SourceBuffer`) is designed for multiplexed audio/video elementary streams encoded in ISO BMFF (fMP4) containers. DASH text tracks — whether TTML, WebVTT-in-ISOBMFF, or IMSC — cannot simply be appended to a `SourceBuffer` and rendered automatically by the browser. They require:

1. **Out-of-band parsing.** The container (fMP4 with a `wvtt` or `stpp` sample entry) must be demuxed. The embedded WebVTT or TTML payload must be extracted from each `mdat` box.
2. **Cue injection.** The extracted cues must be constructed as `VTTCue` or `TextTrackCue` objects and inserted into a `TextTrack` on the `HTMLVideoElement` via `HTMLMediaElement.addTextTrack()` (or a `<track>` element pointing at a synthesised object URL).
3. **Timing alignment.** DASH text segment timing uses the same presentation timeline as video/audio (segment `startTime` + period `@start` offset). The cue `startTime` and `endTime` must be mapped to the video element's `currentTime` coordinate system, accounting for `presentationTimeOffset` and multi-period offsets.
4. **Cue lifecycle management.** As the user seeks or the buffer is trimmed, stale cues must be removed and re-injected. The `TextTrack` API does not automatically evict cues the way `SourceBuffer` evicts media data.

None of this is provided by the browser's MSE API. It requires a purpose-built text track renderer — effectively a small subtitle engine — that sits outside the MSE pipeline.

### What a future implementation would look like

A `<videl-text-track>` element (or logic inside a future `VidelTextRenderer` class) would:

1. Fetch text segments via the same segment-walk logic used by `<videl-representation>`.
2. Demux the fMP4 container to extract the raw TTML or WebVTT payload per segment.
3. Parse the payload into cue objects.
4. Call `videoElement.addTextTrack('subtitles', label, lang)` once per active text adaptation set, then `track.addCue(new VTTCue(...))` for each cue in the segment.
5. Remove cues for evicted/replaced segments.

The video element reference would need to be threaded from `<videl-player>` down to the text renderer, or the renderer would dispatch `videl:ui:add-cues` events caught by the player (consistent with the existing `videl:ui:*` event contract).

This work is deferred until the core audio/video pipeline is stable. Text tracks are fully excluded from MSE operations to prevent any attempt to append text ISOBMFF data to a video or audio `SourceBuffer`, which would produce a `QuotaExceededError` or silent corruption.

---

## Consequences

### Positive

- Audio track switching is near-instantaneous: the buffer trim and new segment fetch happen within one or two pump cycles (≤ 500 ms at default tick rate).
- The SourceBuffer serialisation queue guarantees correct ordering of the remove + reinit sequence with no additional locking.
- Video quality locking gives advanced users direct control while preserving ABR as the default.
- Text track skipping is explicit and documented rather than silently broken.

### Negative / Trade-offs

- **Text tracks remain unavailable.** Users who rely on subtitles or captions cannot use them until the text renderer is implemented.
- **Audio codec switching is implicit.** If two audio adaptation sets use different codecs, `SourceBuffer.changeType()` is called during the first pump tick after activation. Streams that do not support `changeType` will fire `videl:mse:incompatible`. In practice, most multi-language DASH streams encode all audio tracks with the same codec.
- **Buffer trim latency.** The `remove(currentTime, Infinity)` call must complete before new audio data is appended. On slow devices, this may add a brief period of audio silence during the switch. This is preferable to the alternative (playing the wrong language indefinitely).

---

## References

- [MSE specification — SourceBuffer.remove()](https://www.w3.org/TR/media-source/#dom-sourcebuffer-remove)
- [DASH-IF IOP — AdaptationSet switching](https://dashif.org/docs/DASH-IF-IOP-v4.3.pdf)
- [W3C WebVTT specification](https://www.w3.org/TR/webvtt1/)
- [W3C TTML / IMSC specification](https://www.w3.org/TR/ttml2/)
- [MDN: TextTrack API](https://developer.mozilla.org/en-US/docs/Web/API/TextTrack)
- [ADR-0001](./ADR-0001-mse-ownership-and-lifecycle.md) — MSE ownership and SourceBuffer lifecycle
- [ADR-0002](./ADR-0002-attribute-state-vs-slot-state.md) — `videl-state` attribute contract
