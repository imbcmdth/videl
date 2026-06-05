# LEMMA.md - videl-castro

*Last Updated: 2026-06-01*

This is the shared memory for all agents working on the `videl-castro` project. Read this first.

## Answered Questions

- **[2026-06-01] Primary User Persona?** Professional video engineers at larger companies. Project will be open source, so documentation, build tooling, and governance are very important.
- **[2026-06-01] V1 Goal?** Play the most common DASH formats.
- **[2026-06-01] Success Metric?** Simplicity in accomplishing complex tasks like ad insertion or other splicing tasks (i.e., minimal "special sauce" required).
- **[2026-06-01] V1 Scope?** DASH support (common formats), VOD first. Live streaming is a V1 **stretch goal**, not a firm requirement. No HLS, no DRM.

## Tech Stack

- **[2026-06-01] Language:** TypeScript
- **[2026-06-01] Component base:** Lit (`LitElement`) — reactive properties, debug `render()` on all elements; ~5KB, no framework lock-in for consumers
- **[2026-06-01] Build:** esbuild — fast, minimal, library-appropriate; ESM + types output
- **[2026-06-01] Testing:** Playwright — real browser MSE behavior; no mocks
- **[2026-06-01] Commits:** Conventional Commits — enables auto-generated changelogs
- **[2026-06-01] License:** MIT
- **[2026-06-01] UI:** No custom UI shipped; `videl-castro` extends `CustomVideoElement` for `media-chrome` compatibility
- **[2026-06-01] DASH parsing:** Custom minimal parser — produces DOM tree, no full DASH.js dependency

## Decisions

- **[2026-06-01] Core architecture:** DOM-mirror of the DASH manifest. Manifest XML → tree of custom elements (`videl-presentation`, `videl-period`, `videl-adaptation-set`, `videl-representation`, `videl-segment`). Attributes resolved/denormalized at parse time.
- **[2026-06-01] Imperative split:** DOM is the data/config model. `<videl-segment>` is the execution leaf — owns its own fetch + MSE `appendBuffer` lifecycle.
- **[2026-06-01] Customization contract:** Attribute contract + CustomEvent contract per element type. No subclassing of videl internals required — contract is the DOM interface.
- **[2026-06-01] Live streaming:** V1 stretch goal. VOD validated first.
- **[2026-06-01] Segment URL resolution:** Parser resolves SegmentTemplate (priority), SegmentBase, SegmentList and stamps absolute URLs + byte ranges onto `<videl-segment>` attributes. Elements do no URL math.
- **[2026-06-01] Mixin architecture:** `PickOneMixin` (pick-1 slot lifecycle), `PickNMixin` (pick-n slot lifecycle, one per content-type key), `SequentialMixin` (advance in DOM order). Elements with unique conditional logic (`videl-period`, `videl-adaptation-set`, `videl-representation`) implement their own selection on top of the cardinality mixin.
- **[2026-06-01] Slot states:** three only — `unslotted` (no attribute), `next`, `active`. No done/error/evicted. Completion/error signaled via CustomEvents; parent removes `slot` in response. Direct `unslotted → active` must work on all elements (prefetch is an optimization).
- **[2026-06-01] Deactivation cascade:** when a parent is deactivated (slot removed), it synchronously strips `slot` from all slotted children. Invariant: exactly one active path root-to-leaf at all times (per content type).
- **[2026-06-01] Segment fetch abort:** `<videl-segment>` holds an `AbortController`; aborts on `slot` removal. Covers seek, ABR switch, and cascade deactivation.
- **[2026-06-01] State propagation:** pump — `videl-castro` calls `update(PlayerState)` down the active path on each throttled tick (default 250ms, configurable via `tick-ms`). Events — completion/error bubble upward immediately via CustomEvents.
- **[2026-06-01] Debug rendering:** `debug` attribute on any element triggers a visual `render()` of its data and slot state via Lit. No-op in production.
- **[2026-06-02] Private fields:** Use native ES private class fields (`#field`) rather than underscore-prefixed naming conventions (`_field`). Modern browsers are the target; `#` fields are supported and provide true encapsulation.
- **[2026-06-04] Element-as-card pattern:** Custom elements that serve as both a data container and a visual unit (e.g. `<videl-presentation>` as a playlist card) should expose a single default `<slot>` rather than named composition slots. User content goes directly inside the element with no `slot` attribute required. Technical children injected by the element itself (e.g. `<videl-period>`) are hidden by a targeted `::slotted(videl-period) { display: none }` rule — present in the composed tree for DevTools inspection, invisible by default. The element itself is styled as the card via CSS (`videl-presentation { … }`). This is simpler than the previous `slot="card"` pattern and eliminates the need for a wrapper div.

- **[2026-06-04] Segment duration mismatch and timeline drift:** MPEG-DASH manifests declare segment `duration` values that routinely differ from the actual media duration produced by the encoder. This is normal and expected, not a bug. Root causes include:
  - **Priming / pre-roll samples:** H.264/H.265 encoders emit B-frame dependencies before the first displayed frame. These samples exist in the bitstream and occupy buffer time even though they precede the nominal segment start.
  - **Non-zero start PTS:** The first sample in a segment may have a presentation timestamp (PTS) slightly above the declared `startTime`, creating a small gap between the declared start and the first decodable frame.
  - **Splice points and ad insertion:** Cutting to a new piece of content rarely lands on an exact sample boundary; a few ms of media is typically trimmed or padded.
  - **Timescale rounding:** Segment durations in the MPD are expressed in a fixed `timescale` (e.g. 90000 ticks/s). Rounding the sample count to integer ticks introduces small systematic drift that accumulates over a long stream.

  In practice, a segment declared as 3.84 s may only buffer 3.669 s. After N segments the discrepancy can be several seconds.

  **The bug this caused (discovered on a multi-adaptation-set stream):** The audio track had a segment declared as 3.84 s. After appending, the SourceBuffer contained 3.669 s of audio. On the next pump tick, `currentTime` was 3.64 s — inside the declared segment range but past the actual buffer end. The original `isBuffered` check required the buffer to extend to at least `3.84 - 0.1 = 3.74 s`, which 3.669 s did not satisfy. So the walk concluded segment 0 was *not* fully buffered, found it was already `videl-state="active"`, and the guard `videl-state !== "active"` prevented re-activation. The walk was stuck on segment 0 permanently: the first `videl:done` *had* fired (append succeeded), but the pump never advanced to segment 1. No further audio was ever appended. The symptom — visible in the DevTools — was segment 0 holding `videl-state="active"` and segment 1 holding `videl-state="next"` indefinitely with no state transitions.

  **The key insight:** segment selection must be driven by feedback from actual appends (what the SourceBuffer reports after `updateend`) rather than by the manifest's declared timeline. The manifest is a scheduling hint, not a guarantee of what the encoder will produce. Consequences for the pump:
  - `isBuffered(startTime, duration, buffered)` with a tight absolute tolerance (e.g. 100 ms) incorrectly reports the segment as *not* fully buffered, causing the walk to stall at the same segment forever.
  - The MPD-declared `startTime` of segment N+1 no longer matches the actual SourceBuffer end after segment N, so the walk may skip over the wrong segments or re-activate already-appended ones.

  **Mitigations in videl (current):**
  1. `isBuffered` uses `max(0.5 s, 15 % of declared duration)` as tolerance — generous enough to absorb real-world encoder variance without causing false positives on genuinely partial appends.
  2. `#fetchedSegments` (a `Set<Element>`) tracks segments whose bytes have been confirmed as written to the SourceBuffer (`videl:done` fired). The pump walk skips entries in this set regardless of what `isBuffered` returns, preventing the stuck-segment loop.
  3. `#timelineDrift` accumulates the difference `actualBufferEnd − mpdDeclaredEnd` after each append. Subsequent segment-selection logic uses `startTime + timelineDrift` as the effective position, keeping the walk aligned with the real buffer even after large cumulative drift.
  4. Both `#fetchedSegments` and `#timelineDrift` are cleared on seek, `sourceBuffer` reassignment, and deactivation — stale tracking from a previous continuous run is never applied to a new starting position.

  **Important: `#fetchedSegments` is populated only in `#onSegmentDone`** (after `updateend` confirms the append), never at `activateChild` or `preloadChild` time. Adding a segment at activation time would cause the walk to skip it on the very next tick and attempt to activate the *next* segment — cancelling the still-in-flight fetch via `PickOneMixin.activateChild` removing `videl-state` from the downloading segment.

- **[2026-06-04] MSE seekable range — VOD vs live:** `HTMLVideoElement.seekable` is not derived from `MediaSource.duration` alone. There are two distinct mechanisms:
  - **VOD / static streams:** set `MediaSource.duration` to the manifest's `mediaPresentationDuration`. The browser exposes `seekable = [0, duration]`. Must be set while `readyState === 'open'` and after all `SourceBuffer` instances are added (so the value cannot be less than any already-buffered end time).
  - **Live / dynamic streams:** `MediaSource.duration` should be set to `Infinity`, but that alone does not give the browser a useful seekable window — the window shrinks as the live edge advances and old segments are evicted. For live, use `MediaSource.setLiveSeekableRange(start, end)` to explicitly declare the current valid seek window (typically DVR depth behind the live edge to the live edge). Call it periodically as the manifest is refreshed. Forgetting this makes `seekable` effectively empty for live, so the player cannot seek within the DVR window.

- **[2026-06-03] Public method/property naming:** Any public method or property on a videl custom element that uses a generic name shared with browser or framework built-ins **must** be prefixed with `videl`. This prevents silent collisions with LitElement, HTMLElement, or future platform APIs. Examples: the element pump method is `videlUpdate(state: PlayerState)` — not `update()`, which collides with `LitElement.update(changedProperties)`. Attribute-reflected reactive properties (e.g. `duration`, `start`, `slot`) are exempt because they are intentionally mapping to HTML attribute names.
- **[2026-06-01] ADD:** `planning/ADD-001-dom-mirror-architecture.md`

## User Preferences

_(Corrections, feedback, or stated preferences from the human.)_

## Project Constraints

- **[2026-06-01] V1 is DASH-only.** No HLS support.
- **[2026-06-01] V1 has no DRM.** This will be a later feature.
