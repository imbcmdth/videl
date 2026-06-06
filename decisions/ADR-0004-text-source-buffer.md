# ADR-0004: TextSourceBuffer — Fake SourceBuffer for DASH Text Tracks

**Date:** 2026-06-05  
**Status:** Accepted  
**Deciders:** Project contributors

---

## Context

DASH manifests expose text adaptation sets (subtitles, captions) alongside
audio and video. The browser's MSE API has no mechanism to render text from an
MP4 container — text segments must be demuxed, parsed, and injected into the
`HTMLVideoElement`'s native `TextTrack` API as `VTTCue` objects.

Before this ADR, text adaptation sets were explicitly skipped in
`videl-period.#activateAll()` and `#preloadAll()` with a hard `continue` guard.
No `SourceBuffer` was created for text content.

The design question: how should text tracks be wired into the existing element
tree so that `videl-adaptation-set`, `videl-representation`, and `videl-segment`
remain agnostic about whether they are feeding real media bytes or text cues?

---

## Decision

### ISourceBuffer interface

Extract the public surface of `ManagedSourceBuffer` into a TypeScript interface
`ISourceBuffer` (`src/text-track/i-source-buffer.ts`). Both `ManagedSourceBuffer`
(wrapping a real `SourceBuffer`) and `TextSourceBuffer` (the fake text buffer)
implement this interface. All elements below `videl-player` type their
`sourceBuffer` property against `ISourceBuffer`, making the source of the data
(MSE vs TextTrack) fully transparent to the element tree.

`ISourceBuffer` adds:
- `timestampOffset: number` — now standardised across both buffer types
- `show?(): void` / `hide?(): void` — optional hooks for TextTrack visibility;
  no-op (absent) on `ManagedSourceBuffer`

### TextSourceBuffer

`TextSourceBuffer` (`src/text-track/text-source-buffer.ts`) implements
`ISourceBuffer` and owns a `TextTrack` created via `videoEl.addTextTrack()`.

Key design choices:

**Single shared buffer per content type.** One `TextSourceBuffer` is created
per presentation (keyed `"text"` in `videl-player`'s `#sourceBuffers` map),
shared across all text adaptation sets — identical to the audio model. Text
track switching trims the buffer via `remove(currentTime, Infinity)` to clear
cues from the current playhead forward, then the new ADS's representation
starts appending. This reuses the existing `videl:track:select` / period
`#onTrackSelect` mechanism without modification to the event contract.

**Serialised operation queue.** Mirrors `ManagedSourceBuffer`: one
append/remove in flight at a time; queued operations await their turn. Text
parsing is synchronous so each operation resolves on the same microtask — no
`updateend` event wait needed.

**Replace-on-append.** Before injecting cues from a new segment, existing
cues overlapping the segment's time range are removed first. This provides the
same "buffer overwrite" semantic as a real `SourceBuffer` — appending new
data for a range that already has cues replaces the old cues with the new ones.

**Init vs media segment detection.** A segment is classified as an init
segment if its first box has fourcc `moov`. Init segments update the demuxer's
timescale and container codec; they carry no presentation-time data so
`buffered` is not updated for them.

**Buffered range tracking.** `SyntheticTimeRanges` maintains a sorted,
non-overlapping list of `[start, end]` pairs. `append()` adds the PTS range
of each segment batch; `remove()` cuts the range. This gives
`videl-representation`'s `bufferedAhead` and `isBuffered` checks the same
interface as the browser's native `TimeRanges`.

### fMP4 text demuxer

`Fmp4TextDemuxer` (`src/text-track/fmp4-text-demuxer.ts`) walks ISOBMFF boxes
to extract:
- Init segment: timescale from `mdhd`, container codec fourcc from `stsd`
- Media segments: `baseMediaDecodeTime` from `tfdt`, per-sample duration/size
  from `trun` (with `tfhd` defaults), byte ranges sliced from `mdat`

The container codec (`wvtt` or `stpp`) is the top-level box fourcc. All TTML
sub-profiles (IMSC1 text, EBU-TT-D, etc.) share the `stpp` fourcc at this
level. Sub-profile discrimination uses the codec string from the MPD manifest.

### Codec classification

`classifyTextCodec()` (`src/text-track/text-codec.ts`) maps the MPD codec
string to a `TextCodecClass` discriminated union:

| Codec string | Kind | Support |
|---|---|---|
| `wvtt` | `wvtt` | WebVTT-in-ISOBMFF — full |
| `stpp` | `stpp-text` | Generic TTML — basic `<p>` extraction |
| `stpp.ttml.im1t` | `stpp-text` | IMSC1 text — full (subset of TTML, same parser) |
| `stpp.ttml.im2t` | `stpp-text` | IMSC2 text — full (same parser) |
| `stpp.ttml.etd1` | `stpp-text` | EBU-TT-D — full (same parser) |
| `stpp.ttml.im1i` | `stpp-image` | IMSC1 image — **unsupported** (bitmap rendering) |
| `stpp.ttml.im2i` | `stpp-image` | IMSC2 image — **unsupported** |

Image-profile segments are silently discarded with a one-time `console.warn`.

### Payload parsers

**wvtt** (`src/text-track/wvtt-parser.ts`): Reads `vttc` → `iden`/`sttg`/`payl`
sub-boxes. Timing from fMP4 container (sample PTS + duration). Returns
`WvttCueData { id, payload, settings }`.

**stpp** (`src/text-track/stpp-parser.ts`): Parses UTF-8 TTML XML via
`DOMParser`. Extracts `<p>` elements (TTML namespace first, bare fallback).
Reads `begin`/`end` as SMPTE clock-time relative to the sample PTS. Returns
`StppCueData { id, payload, begin, end }` where begin/end are relative seconds.
The caller adds the sample's presentation time to produce absolute cue times.

### "None" adaptation set

A synthetic `<videl-adaptation-set content-type="text" videl-text-none="" label="None">`
is injected by the MPD parser as the **first** text ADS in each period that
contains real text adaptation sets. It is a real ADS element that participates
in the full slot lifecycle:

- Activated first by default (`selectAdaptationSet` returns `candidates[0]`)
- Renders its own `.track` row in the subtitle menu
- When activated, calls `TextSourceBuffer.hide()` (subtitles off by default)
- When a real language ADS is activated, `TextSourceBuffer.show()` is called

This eliminates any special-casing in `videl-period`'s shadow DOM template.

### presentationTimeOffset wiring

The MPD parser stamps `timestamp-offset = periodStart - pto/timescale` on
each `videl-representation` element (omitted when zero). After the init
segment is appended, `videl-representation` sets `sourceBuffer.timestampOffset`
to this value. For real `SourceBuffer`s this corrects the browser's DTS→PTS
mapping for streams with non-zero `@presentationTimeOffset`. For
`TextSourceBuffer` it is applied directly when constructing `VTTCue` times:
`presentationTime = sample.pts + timestampOffset`.

### endOfStream gating

`videl-player.#maybeEndOfStream()` excludes text buffers from its EOS check —
text cue presence never gates `MediaSource.endOfStream()`.

---

## Consequences

### Positive

- **Transparent to the element tree.** `videl-adaptation-set`, `videl-representation`,
  and `videl-segment` are entirely unaware of whether their source buffer is
  real MSE or a fake text buffer. No content-type checks below `videl-player`.
- **Full SourceBuffer semantics.** `remove()`, `abort()`, `timestampOffset`,
  `updating`, `buffered`, and `changeType()` all behave consistently.
- **Replace-on-append.** Seeking and track switching produce correct cue state
  without stale subtitles lingering from a previous buffer fill.
- **Subtitles off by default.** The "None" ADS pattern requires zero special UI
  code — it's just another ADS row in the menu, active by default.
- **presentationTimeOffset corrected for all content types.** The `timestamp-offset`
  attribute fix benefits audio/video as well as text.

### Negative / Trade-offs

- **Image-based TTML unsupported.** `stpp.ttml.im1i` and `stpp.ttml.im2i` are
  silently discarded. Bitmap subtitle rendering would require a canvas overlay.
- **TTML styling ignored.** Region, font, colour, and positioning from TTML
  markup are not applied to `VTTCue` objects. Plain text only in V1.
- **TTML timing assumed relative.** Per ISO 14496-30, `begin`/`end` in a
  `stpp` sample are relative to the sample's PTS. Non-conformant streams that
  write absolute TTML times will display cues at wrong positions.
- **TextTrack cannot be removed.** The `addTextTrack()` API provides no removal
  method. On presentation teardown, cues are cleared and `mode` is set to
  `'disabled'`, but the track entry remains in `videoEl.textTracks` for the
  lifetime of the video element.

---

## References

- [ISO 14496-30 — Carriage of WebVTT and TTML in ISOBMFF](https://www.iso.org/standard/75395.html)
- [IMSC1 — W3C TTML Profiles for Internet Media Subtitles and Captions](https://www.w3.org/TR/ttml-imsc/)
- [DASH-IF IOP — Text and Closed Captions](https://dashif.org/docs/DASH-IF-IOP-v4.3.pdf)
- [MDN: TextTrack API](https://developer.mozilla.org/en-US/docs/Web/API/TextTrack)
- [ADR-0001](./ADR-0001-mse-ownership-and-lifecycle.md) — MSE ownership and SourceBuffer lifecycle
- [ADR-0003](./ADR-0003-audio-track-switching-and-text-track-deferral.md) — supersedes the text-track deferral portion
