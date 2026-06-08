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
- **[2026-06-01] UI:** `<videl-presentation>` owns the control bar UI (seekbar, play/pause, volume, quality/audio menus, fullscreen). `<videl-player>` exposes an `HTMLMediaElement`-compatible JS proxy surface (`play`, `pause`, `currentTime`, `duration`, `volume`, `muted`, `paused`, `buffered`, `readyState`, `playbackRate`) for programmatic control.
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

- **[2026-06-05] TextSourceBuffer (fake SourceBuffer for text tracks):** A `TextSourceBuffer` class implements `ISourceBuffer` — the same interface as `ManagedSourceBuffer` — and routes fMP4 text segments through an ISOBMFF demuxer and payload parsers (`wvtt` / `stpp`), injecting `VTTCue` objects into a `TextTrack` owned by the video element. This makes the element tree (`videl-adaptation-set`, `videl-representation`, `videl-segment`) completely agnostic about text vs media content — no `content-type === 'text'` guards below `videl-player`. Key invariants: one `TextSourceBuffer` per presentation (shared across all text adaptation sets in the same period, like audio); `remove(s, Infinity)` clears cues from s forward for track switching; replace-on-append removes existing cues in a new segment's range before inserting new cues; text is excluded from the `endOfStream` gate; image-based TTML (`stpp.ttml.im1i/im2i`) is silently discarded with a one-time warning. See ADR-0004.

- **[2026-06-05] "None" text adaptation set:** The MPD parser injects a synthetic `<videl-adaptation-set content-type="text" videl-text-none="" label="None">` as the **first** text ADS in each period that has real text ADS children. It is activated first by default (subtitles off by default). When it becomes active, it calls `TextSourceBuffer.hide()`. When a real language ADS is activated, it calls `TextSourceBuffer.show()`. This is handled entirely within `videl-adaptation-set.attributeChangedCallback` — no special-casing in the period or player.

- **[2026-06-05] ISourceBuffer interface:** `src/text-track/i-source-buffer.ts` defines `ISourceBuffer` with `append`, `remove`, `abort`, `changeType`, `updating`, `buffered`, `timestampOffset`, and optional `show?`/`hide?`. Both `ManagedSourceBuffer` and `TextSourceBuffer` implement it. All elements below `videl-player` use this type for their `sourceBuffer` property.

- **[2026-06-05] presentationTimeOffset wiring:** The MPD parser stamps `timestamp-offset = periodStart - pto/timescale` on each `videl-representation` element (attribute omitted when 0). After the init segment is appended, `videl-representation` sets `sourceBuffer.timestampOffset` to this value. For real `SourceBuffer`s this fixes audio/video alignment for non-zero `@presentationTimeOffset` streams; for `TextSourceBuffer` it is applied directly when constructing `VTTCue` presentation times.

- **[2026-06-05] Data-as-UI menus (track / quality selectors):** The audio, subtitle, and quality selector menus are NOT built by querying the DOM and rendering new control nodes. The existing `<videl-adaptation-set>` and `<videl-representation>` elements ARE the menu items — each renders its own visual row (`videl-adaptation-set` → a track row labelled by `lang`/`content-type`; `videl-representation` → a quality row labelled by resolution/bandwidth), highlighting itself when `videl-state="active"`. The control-bar buttons (static nodes in `<videl-presentation>`'s shadow) toggle a `menu-open="audio|text|quality"` attribute on the *active* `<videl-period>` (parent→child attribute, same ownership model as `videl-state`; independent of it per ADR-0002). The period's shadow DOM reveals the matching group purely via CSS using `::slotted()` attribute selectors — `:host([menu-open="audio"]) ::slotted(videl-adaptation-set[content-type="audio"]) { display: block !important }`, and `[content-type="video"][videl-state="active"]` for quality (the active video set surfaces its own representations). Key constraint: `::slotted()` accepts a compound selector (attributes allowed) on the slotted element, which is what makes content-type-based reveal possible without reparenting or new nodes. The menus are informational only for now (no selection/ABR-pinning). The active period is a transparent `pointer-events:none` overlay (`z-index:3`, above the control bar) whose menu popup re-enables `pointer-events:auto`; the popup is positioned at the period's bottom-right so it floats just above the presentation's control bar even though the two live in different shadow trees.

- **[2026-06-05] Presentation-as-player-UI (CSS overlay architecture):** `<videl-presentation>` serves three roles: manifest owner, playlist card (inactive), and full player UI (active). When `videl-state="active"`, the presentation applies `position: absolute; inset: 0; z-index: 2; background: transparent` to itself, overlaying the `<videl-player>` container. The `<video>` element (in the player's shadow DOM, rendered later in DOM order at `z-index: auto`) sits visually behind the transparent overlay; the video content shows through the body. A controls bar rendered at the bottom of the overlay (seekbar, play/pause, time, volume, read-only quality/language labels) constitutes the full player UI. All control interactions are dispatched as internal `videl:ui:*` events (`bubbles: true, composed: true`) and caught by `<videl-player>`, which delegates to `<video>` — the presentation never holds a direct video reference. The seekbar uses a full-width `<input type="range">` as the interaction target; `<videl-period>` boundary positions are rendered as decorative markers on the track (non-interactive). UI state (`currentTime`, `paused`, `volume`, `muted`) is stamped onto the presentation as Lit reactive properties on every `videlUpdate()` pump tick. The player's shadow DOM was restructured to include a `<slot>` (wrapped in `<div class="presentations">`) before the `<video>` so presentations are rendered and styleable. Presentations injected programmatically in single-stream `src` mode carry a `generated` attribute for future CSS targeting.

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

- **[2026-06-07] DOM-first data model:** Prefer stamping data as attributes on custom elements over storing it in internal JavaScript variables or objects. The DOM tree is the authoritative state of the player — attributes represent the externally observable, inspectable, and diffable data model. Internal JavaScript fields (`#field`) represent only transient tracking state that cannot be meaningfully observed from outside the element (e.g. `#fetchedSegments`, `#timelineDrift`, `#initController`). The key test: if an internal field could be fully reconstructed by re-reading the element's attributes and re-running its activation logic from scratch, it belongs as an attribute, not a field.

- **[2026-06-07] Lazy segment generation:** `<videl-segment>` children on a `<videl-representation>` are NOT created at MPD parse time for `SegmentTemplate` or `SegmentBase` addressing modes — only for `SegmentList` (which is a 1:1 XML-to-DOM transform with no computation). For all other modes the parser stamps the raw addressing data as attributes (`segment-template-*`, `segment-base-url`, `segment-base-index-range`) and `VidelRepresentation` creates its `<videl-segment>` children when `videl-state` first becomes `"next"` or `"active"`. For `SegmentBase` streams with a `sidx` box, the representation fetches the index range, parses the ISOBMFF `sidx` box, and creates one `<videl-segment>` per entry. For live (`type="dynamic"`) streams using `SegmentTemplate`, the representation's `videlUpdate()` pump tick calls `#extendLiveSegments()` to append newly-available segments as wall clock time advances — no manifest refresh is required for segment discovery.

- **[2026-06-07] Attribute naming convention:** Three categories govern whether an attribute uses the `videl-` prefix.
  1. **DASH-manifest attributes** — stamped by the MPD parser from MPD XML values (including values derived or computed from MPD data such as `timestamp-offset`, `period-id`, `live`): **no prefix**. Match the DASH attribute name as closely as possible in kebab-case.
  2. **User-configuration attributes** — set by the element consumer to configure behavior (`src`, `debug`, `tick-ms`, `buffer-ahead`, `abr-safety-factor`, `forced-rep`, `playlist-collapsed`): **no prefix**.
  3. **Internal-state attributes** — written by videl processes to record lifecycle or computed state that consumers observe but do not set (`videl-state`, `videl-done`, `videl-populated`, `videl-init-appended`, `videl-bandwidth`, `videl-active-codecs`, `videl-generated`, `videl-no-playlist`, `videl-user-inactive`, `videl-menu-open`, `videl-pinned`, pump-state attrs on `videl-presentation`): **`videl-` prefix required**.
  The diagnostic question: *who writes this attribute?* Parser → no prefix. Consumer → no prefix. videl element writes it to reflect its own state → `videl-` prefix. The HTML built-in `slot` attribute is exempt from all three rules.

- **[2026-06-03] Public method/property naming:** Any public method or property on a videl custom element that uses a generic name shared with browser or framework built-ins **must** be prefixed with `videl`. This prevents silent collisions with LitElement, HTMLElement, or future platform APIs. Examples: the element pump method is `videlUpdate(state: PlayerState)` — not `update()`, which collides with `LitElement.update(changedProperties)`. Attribute-reflected reactive properties (e.g. `duration`, `start`, `slot`) are exempt because they are intentionally mapping to HTML attribute names.
- **[2026-06-01] ADD:** `planning/ADD-001-dom-mirror-architecture.md`

## User Preferences

_(Corrections, feedback, or stated preferences from the human.)_

## Project Constraints

- **[2026-06-01] V1 is DASH-only.** No HLS support.
- **[2026-06-01] V1 has no DRM.** This will be a later feature.
