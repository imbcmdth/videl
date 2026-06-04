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

- **[2026-06-03] Public method/property naming:** Any public method or property on a videl custom element that uses a generic name shared with browser or framework built-ins **must** be prefixed with `videl`. This prevents silent collisions with LitElement, HTMLElement, or future platform APIs. Examples: the element pump method is `videlUpdate(state: PlayerState)` — not `update()`, which collides with `LitElement.update(changedProperties)`. Attribute-reflected reactive properties (e.g. `duration`, `start`, `slot`) are exempt because they are intentionally mapping to HTML attribute names.
- **[2026-06-01] ADD:** `planning/ADD-001-dom-mirror-architecture.md`

## User Preferences

_(Corrections, feedback, or stated preferences from the human.)_

## Project Constraints

- **[2026-06-01] V1 is DASH-only.** No HLS support.
- **[2026-06-01] V1 has no DRM.** This will be a later feature.
