# ADD-001: videl-castro Architecture Design Document

**Status:** Draft  
**Date:** 2026-06-01  
**Author:** [Bot]Arch

---

## 1. Overview

`videl-castro` is a DASH video player built on a single architectural principle: **the DASH manifest is the DOM.** Parsing a manifest produces a live tree of custom elements that is directly inspectable and mutable via standard DOM APIs. Customization is achieved by substituting default element implementations, not by hooking into opaque internal event buses.

---

## 2. Core Architectural Principle

A DASH MPD document has a well-defined hierarchical structure:

```
MPD
└── Period
    └── AdaptationSet
        └── Representation
            └── Segment(s)
```

This maps 1:1 to a DOM tree:

```html
<videl-presentation>
  <videl-period>
    <videl-adaptation-set>
      <videl-representation>
        <videl-segment></videl-segment>
        <videl-segment></videl-segment>
      </videl-representation>
    </videl-adaptation-set>
  </videl-period>
</videl-presentation>
```

DASH XML attributes become element attributes. Inheritance rules (e.g., codec info propagated from `AdaptationSet` → `Representation`) are resolved at parse time and stamped onto the leaf elements. The DOM is the resolved, denormalized state — not a raw copy of the XML.

Ad insertion is then just: insert a `<videl-period>` at the right index. Splice points are visible. No special APIs needed.

---

## 3. Slot Selection Model

Every element in the tree exposes a uniform **slot selection** interface. Each element manages a set of child slots and is responsible for promoting children into those slots based on its selection strategy. Two dimensions parameterize each element:

| Dimension | Options |
|-----------|---------|
| **Cardinality** | `pick-1` — one active child at a time; `pick-n` — multiple active children simultaneously |
| **Strategy** | `sequential` — advance in DOM order; `conditional` — selection driven by runtime state |

### Slot States

Slot state is reflected via the `slot` attribute on each child element. There are only three states:

| Value | Meaning |
|-------|---------|
| *(absent)* | `unslotted` — default; element is inactive and holds no resources |
| `next` | Flagged as upcoming; element begins prefetching |
| `active` | Currently selected and executing |

Completion and error are **not** slot states — they are signaled via CustomEvents. The parent responds by removing the child's `slot` attribute (→ `unslotted`) and promoting the next candidate.

**Valid transitions:**
```
unslotted → next → active   (normal path; prefetch enabled)
unslotted → active           (direct path; always supported — prefetch is an optimization, not a requirement)
any → unslotted              (deactivation or post-completion cleanup)
```

The **parent** is responsible for setting and removing `slot` on its children. The **child** is responsible for reacting to `slot` changes.

`next` is strictly singular at every level — only one child may hold `slot=next` at a time.

### Selection Strategy Per Element

| Element | Cardinality | Strategy | Notes |
|---------|-------------|----------|-------|
| `<videl-castro>` | pick-1 | sequential | Playlist of presentations; advances when current presentation ends |
| `<videl-presentation>` | pick-1 | sequential | Advances through periods in DOM order |
| `<videl-period>` | pick-n | conditional | Selects one adaptation set per content type (video + audio + optional text) simultaneously |
| `<videl-adaptation-set>` | pick-1 | conditional | ABR: selects representation based on bandwidth + quality |
| `<videl-representation>` | pick-1 | conditional | Selects segment by `currentTime` + buffer state; sequential is the common case but seek and ABR switch bypass it |

---

## 4. Class Mixin Architecture

Selection behavior is implemented via composable TypeScript class mixins, keeping shared logic out of the element classes themselves.

### Mixins

**`PickOneMixin(superclass)`**
- Manages the `slot` lifecycle for pick-1 elements.
- Ensures at most one child holds `slot=active` and at most one holds `slot=next` at any time.
- Handles all valid transitions: `unslotted → next → active`, `unslotted → active`, `any → unslotted`.
- Fires `videl:slot:change` CustomEvent when slots change.

**`PickNMixin(superclass)`**
- Manages the `slot` lifecycle for pick-n elements.
- Allows N children to hold `slot=active` simultaneously (one per content type key).
- Still enforces singular `slot=next` at the element level.
- Subclass provides the content-type grouping key via `getSlotKey(child): string`.

**`SequentialMixin(superclass)`**
- Implements sequential selection strategy.
- On `videl:segment:done` (or equivalent completion event): promotes the next sibling in DOM order to `slot=next`, then `slot=active`.
- Composable on top of either `PickOneMixin` or `PickNMixin`.

### Deactivation Cascade

When a parent element's own `slot` is removed, it **must synchronously deactivate all of its slotted children** before completing its own transition. This is enforced in both `PickOneMixin` and `PickNMixin`.

Deactivation means: remove the `slot` attribute from every child that currently holds `slot=next` or `slot=active`. This triggers each child's own `attributeChangedCallback`, which cascades deactivation further down the tree.

The result is a hard invariant: **at any point in time, there is exactly one active path from `<videl-castro>` to a leaf `<videl-segment>` (per content type).** No two branches of the tree can be simultaneously active.

Deactivation is synchronous to eliminate any window where multiple active paths could coexist.

### Composition Per Element

```
videl-castro         = SequentialMixin(PickOneMixin(LitElement))
videl-presentation   = SequentialMixin(PickOneMixin(LitElement))
videl-period         = PickNMixin(LitElement)          + custom contentType selection
videl-adaptation-set = PickOneMixin(LitElement)        + custom ABR selection
videl-representation = PickOneMixin(LitElement)        + custom time/buffer selection
videl-segment        = LitElement                      (leaf; no selection)
```

`videl-period`, `videl-adaptation-set`, and `videl-representation` have unique conditional logic that is not shared — they implement their own selection on top of the cardinality mixin.

---

## 5. Element Hierarchy & Responsibilities

### 5.1. `<videl-castro>` — Orchestrator

- Extends `CustomVideoElement` (from the `media-chrome` ecosystem) to expose a minimal `HTMLMediaElement`-compatible interface.
- This makes `videl-castro` a drop-in media source for `media-chrome` controls with no custom UI layer required.
- Accepts `src` attribute (MPD URL).
- On `src` change: fetches the manifest, parses it, constructs the DOM subtree.
- Owns the `MediaSource` object; attaches it to the internal `<video>` element via `URL.createObjectURL`.
- Observes the element tree via `MutationObserver` to react to developer mutations (e.g., ad insertion, period reordering).
- Manages top-level playback state: `play`, `pause`, `seek`, current time, buffered ranges.
- Does **not** fetch segments or touch MSE SourceBuffers directly — delegated to `<videl-segment>`.
- Mixin: `SequentialMixin(PickOneMixin(CustomVideoElement))`

### 5.2. `<videl-presentation>` — MPD root

- Holds top-level MPD attributes: `mediaPresentationDuration`, `minBufferTime`, `type` (static/dynamic), `profiles`.
- For live (stretch): holds `availabilityStartTime`, `suggestedPresentationDelay`.
- Prefetch behavior (`slot=next`): fetch and parse the manifest URL for the next presentation in the playlist.
- Mixin: `SequentialMixin(PickOneMixin(LitElement))`

### 5.3. `<videl-period>` — Period

- Attributes: `id`, `start`, `duration`.
- Children are `<videl-adaptation-set>` elements.
- Period ordering in the DOM defines playback order — reordering elements reorders playback.
- Prefetch behavior (`slot=next`): prepare adaptation sets, check segment availability.
- Custom conditional selection: activates one child per content type (`video`, `audio`, `text`).
- Mixin: `PickNMixin(LitElement)` + custom selection

### 5.4. `<videl-adaptation-set>` — AdaptationSet

- Attributes: `mimeType`, `codecs`, `lang`, `contentType` (video/audio/text).
- Orchestrator routes SourceBuffer assignment by `contentType`.
- Owns ABR logic — promotes one child `<videl-representation>` to `slot=active` based on current bandwidth estimate.
- Custom conditional selection: ABR-driven.
- Mixin: `PickOneMixin(LitElement)` + custom selection

### 5.5. `<videl-representation>` — Representation

- Attributes: `id`, `bandwidth`, `width`, `height`, `codecs`, `mimeType` (resolved from parent if absent).
- Selects which `<videl-segment>` child to activate based on `currentTime` and buffer state.
- After seek or ABR switch: resolves correct segment by time, not position.
- Prefetch behavior (`slot=next`): fetch the initialization segment for this representation.
- Custom conditional selection: time/buffer driven.
- Mixin: `PickOneMixin(LitElement)` + custom selection

### 5.6. `<videl-segment>` — Segment (the execution leaf)

This is where the imperative layer lives. The segment is an abstraction over fetching — its primary contract is: given a URL and optional byte range, deliver bytes to a SourceBuffer.

**Slot progression:**
```
unslotted → next (prefetch) → active (append)   — normal path
unslotted → active (fetch + append inline)        — direct path; always supported
any → unslotted                                   — deactivation; abort in-flight work
```

**Key insight:** `slot=active` at the segment level means data is in the SourceBuffer. `slot=next` means fetch and buffer ahead of the playhead. Prefetch is an optimization — direct activation must also work.

**Responsibilities:**
- Reads its own attributes (`url`, `byteRange`, `startTime`, `duration`) set by the parser.
- On `slot=next`: issues `fetch()` via an internal `AbortController`; holds bytes in memory.
- On `slot=active`: if bytes are already prefetched, append immediately; otherwise fetch-then-append inline.
- On `slot` removed (deactivation): **immediately aborts** any in-flight fetch via `AbortController.abort()`.
- Fires `videl:segment:done` on successful append; `videl:segment:error` on failure. Parent responds by removing `slot` and promoting the next child.

**Customization point:** Replace with any element honoring the same attribute + event contract (e.g., a P2P fetch element). The parent does not care how bytes arrive.

---

## 6. Debug Rendering

All elements extend `LitElement`. In production, non-UI elements return an empty template from `render()`. When a `debug` attribute is present, `render()` returns a visual representation of the element's data and slot state — making the full manifest tree inspectable in the browser's DOM without devtools.

```html
<videl-castro src="..." debug>
  <!-- each child renders its own debug view -->
</videl-castro>
```

This is not a separate debug mode — it's a natural consequence of Lit's `render()` being conditional on the `debug` attribute.

---

## 7. UI: media-chrome Integration

`videl-castro` ships **no UI layer**. Instead, it exposes the `HTMLMediaElement` interface via `CustomVideoElement` and is designed to be controlled by [`media-chrome`](https://github.com/muxinc/media-chrome).

```html
<media-controller>
  <videl-castro slot="media" src="https://example.com/stream.mpd"></videl-castro>
  <media-control-bar>
    <media-play-button></media-play-button>
    <media-time-range></media-time-range>
    <media-mute-button></media-mute-button>
  </media-control-bar>
</media-controller>
```

`media-chrome` controls work out of the box with no configuration.

---

## 8. State Propagation Model

Elements are driven by two complementary mechanisms:

### 8.1. Pump (time-driven, downward)

`videl-castro` subscribes to the internal `<video>` element's `timeupdate` event and throttles it to a configurable interval (default: **250ms**). On each tick it calls `update(state: PlayerState)` on its active `videl-presentation`. That element calls it on the active `videl-period`, which calls it on its active adaptation sets, and so on down the tree.

```ts
interface PlayerState {
  currentTime: number;
  buffered: TimeRanges;
  duration: number;
  readyState: number;
  bandwidth: number; // running estimate maintained by orchestrator
}
```

**Only the active path is pumped.** `unslotted` children are never called. Pump cost is O(depth) — fixed at ~5 levels regardless of total element count.

The throttle interval is configurable via a `tick-ms` attribute on `<videl-castro>` (default `250`).

### 8.2. Events (completion-driven, upward)

Completion and error signals fire immediately and bubble up via CustomEvents — they do not wait for the next pump tick.

| Event | Fired by | Meaning |
|-------|----------|---------|
| `videl:segment:done` | `<videl-segment>` | Bytes appended to SourceBuffer |
| `videl:segment:error` | `<videl-segment>` | Fetch or append failed |
| `videl:slot:change` | any element | A child's `slot` attribute changed |
| `videl:representation:switched` | `<videl-adaptation-set>` | ABR selected a new representation |

Parents listen for these events on themselves (bubbled from children) and react immediately — promoting the next segment, triggering error recovery, etc.

### 8.3. Summary

| Concern | Mechanism | Direction |
|---------|-----------|----------|
| Time-driven decisions (buffer health, ABR, seek) | `update(PlayerState)` pump | Downward, active path only |
| Completion / error signals | CustomEvents | Upward, bubble |

---

## 9. The Imperative / Declarative Split

| Layer | Model | Mechanism |
|-------|-------|-----------|
| Manifest structure | Declarative | DOM tree |
| Slot state | Declarative (attribute reflection) | `slot` attribute on each element |
| Byte fetching | Imperative | `<videl-segment>` internal `fetch()` |
| MSE append | Imperative | `<videl-segment>` calls `sourceBuffer.appendBuffer()` |
| Buffer management | Semi-declarative | Orchestrator watches `slot` attributes; drives eviction policy |

The DOM is the source of truth for *what should be played and in what order*. MSE is the mechanism for *how bytes get to the decoder*. These are kept cleanly separated.

---

## 10. Orchestration: How Playback Flows

```
videl-castro
  1. Fetch MPD
  2. Parse → build DOM subtree under <videl-presentation>
  3. Create MediaSource, attach to internal <video>
  4. On sourceopen: create SourceBuffers (one per active content type)
  5. Pass SourceBuffer refs to relevant <videl-adaptation-set> elements
  6. Activate initial period → adaptation sets → representations
  7. Set slot=next on the first <videl-segment> per representation
  8. <videl-segment> self-fetches on slot=next, appends on slot=active
  9. On segment done: advance slot=next to the following segment
 10. On timeupdate: check buffer health; trigger ABR evaluation in adaptation sets
 11. On seek: videl-representation resolves correct segment by time; resets slot chain
```

---

## 11. Customization Contract

A custom element replaces a default implementation by:

1. Extending `HTMLElement` (or the relevant default base class).
2. Honoring the **attribute contract** for that element type.
3. Honoring the **event contract** (same CustomEvents the parent listens for).
4. Registering with a compatible tag name and placing it in the tree.

No subclassing of internal classes is required. The contract is the DOM interface.

**Example — custom P2P segment element:**
```js
class P2PSegment extends HTMLElement {
  static observedAttributes = ['slot'];

  attributeChangedCallback(name, _, value) {
    if (name === 'slot' && value === 'next') this.#prefetch();
    if (name === 'slot' && value === 'active') this.#appendToBuffer();
  }

  async #prefetch() {
    // fetch via P2P network
  }

  async #appendToBuffer() {
    // append to this.sourceBuffer (set by parent)
    this.dispatchEvent(new CustomEvent('videl:segment:done', { bubbles: true }));
  }
}
customElements.define('p2p-videl-segment', P2PSegment);
```

---

## 12. Technology Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Language | TypeScript | Type-safe element + mixin contracts; better DX for a library |
| Component base | Lit (`LitElement`) | Reactive `@property` decorators; debug `render()` on all elements; minimal (~5KB) |
| UI layer | `media-chrome` + `CustomVideoElement` | No custom UI shipped; controls work out of the box via `HTMLMediaElement` interface |
| Build | esbuild | Fast, minimal; library-appropriate; no bundler opinion forced on consumers |
| Testing | Playwright | Real browser MSE behavior; no mocks |
| Commits | Conventional Commits | Enables auto-generated changelogs |
| License | MIT | — |
| Segment fetch | Native `fetch` | No deps; consumers replace the element to change fetch behavior |
| DASH parsing | Custom, minimal | Produces the DOM tree; no full DASH.js-style parser dependency |

---

## 13. Segment URL Resolution Strategy

DASH has three segment addressing modes:

| Mode | Description | V1 Support |
|------|-------------|------------|
| `SegmentBase` | Single segment, byte-range index | ✅ Yes |
| `SegmentTemplate` | URL template + timeline or `$Number$`/`$Time$` | ✅ Yes (priority) |
| `SegmentList` | Explicit list of URLs | ✅ Yes |

The parser resolves whichever mode is present and stamps resolved absolute URLs + byte ranges onto each `<videl-segment>` as attributes. Segment elements never perform URL math.

---

## 14. Known Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| DASH profile variety is vast | Scope V1 to SegmentTemplate + SegmentBase; fail loudly for unsupported profiles |
| MSE SourceBuffer contention | Orchestrator serializes all `appendBuffer` calls per SourceBuffer |
| MutationObserver performance on large manifests | Debounce + batch DOM mutations at parse time; observer fires once after build |
| Live streaming complexity | Explicitly a stretch goal; core architecture validated on VOD first |
| Custom element upgrade timing | Parser creates elements after `customElements.whenDefined` resolves; no upgrade race |
| `CustomVideoElement` API surface | Keep the proxied interface minimal; only expose what `media-chrome` requires |

---

## 15. Out of Scope (V1)

- HLS
- DRM / EME
- Trick play / thumbnails
- Multiple audio track switching UI
- Text tracks / subtitles
- CMAF low-latency chunked transfer
- Every DASH profile (focus on common)

---

## 16. Open Questions

- **Segment eviction policy:** Who decides when a `<videl-segment>` transitions to `evicted` — the element itself or the orchestrator? Recommendation: orchestrator drives eviction policy; element executes the MSE `remove()` call.
- **ABR algorithm:** V1 starts with a simple bandwidth-ladder approach. Custom ABR is pluggable via a custom `<videl-adaptation-set>` implementation.
- **SourceBuffer assignment:** Orchestrator creates SourceBuffers and sets them as a property on the relevant `<videl-adaptation-set>`. Segment elements read it via `closest('videl-adaptation-set').sourceBuffer`.
- **`PickNMixin` slot key:** The grouping key for pick-n selection (content type: `video`/`audio`/`text`) — should this be derived from a child attribute or provided via a method override? Recommendation: method override (`getSlotKey(child)`) for flexibility.
