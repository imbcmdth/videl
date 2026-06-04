# ADR-0002: Decouple Playlist State Management from Shadow DOM Slots

**Date:** 2026-06-04  
**Status:** Accepted  
**Deciders:** Project contributors  
**Supersedes:** (initial DEL-010 design)

---

## Context

### The Problem

During implementation of the multi-presentation playlist feature (DEL-010) a fundamental impedance mismatch was discovered between two uses of the `slot` attribute:

1. **State communication.** The player sets `slot="active"` and `slot="next"` on `<videl-presentation>` children to signal which presentation is currently playing and which should be prefetched. Inside a presentation, the same mechanism propagates downward: the presentation sets `slot="active"` on the active `<videl-period>` child, and so on down the element hierarchy.

2. **Visual composition.** Shadow DOM `<slot name="active">` and `<slot name="next">` elements inside each element's shadow root project the correspondingly-slotted children into the rendered output.

On the surface this looks elegant: one attribute simultaneously signals state and handles layout. In practice it creates an unresolvable conflict:

- **DOM reordering for display.** A slotted child is visually projected into whatever `<slot name="…">` the shadow root declares for it. If the shadow root places `slot[name="active"]` below a debug panel and `slot[name="next"]` above the video, the *rendered* order diverges from the *DOM* order. Worse, when a presentation transitions from `next` → `active` the element appears to jump from one visual location to another, even though it never moved in the real DOM.
- **Visual composition is locked.** Because the slots are occupied by state machinery, a developer cannot independently design the visual layout of the playlist. For example, it is impossible to render all presentation cards in DOM order (episode 1, 2, 3…) while simultaneously using slots for prefetch state — the slots only surface the slotted element, not its neighbours.
- **Shadow DOM inspection is degraded.** When viewing the element in DevTools, the shadow tree shows `<slot name="active">` and `<slot name="next">` as placeholders, which tells the developer nothing about which presentation is active. The information that *matters* — the current state — is hidden behind the slot indirection. Adding a debug UI overlay inside the shadow root collides with the slots because the activated child is rendered at the slot location rather than in the light DOM.
- **Non-sequential playlists have no clean path.** If future selection modes (shuffle, user-pick, branching narratives) activate a presentation that is not the immediate neighbour in DOM order, the "next" slot would refer to a non-adjacent element while the rest remain unslotted. There is no way to express "this element is logically in the queue but visually should remain in its natural position" through slot names alone.

### The Three Candidate Solutions

#### Option A — Expand the Slot Vocabulary

Add `slot` values: `past`, `previous`, `active`, `next`, `future`.  
Every presentation is assigned one of these five values at all times; the shadow root has five named slots in document order.

**Why this falls short:**

- Requires constant housekeeping: on every advance, four transitions happen simultaneously (old-active → past, old-next → active, current-future-head → next, rest stay future).
- Still mixes state and layout: a presentation's visual position is encoded in its slot value.
- Does not generalise to non-sequential selection without either inventing more slot names or abandoning the scheme entirely.
- A shuffle playlist cannot hold DOM order while assigning meaningful slot names.

#### Option B — Multiple Boolean State Attributes

State is tracked through separate boolean attributes: `videl-active` and `videl-next`. Slots are freed for pure visual composition.

**Why this is good but not optimal:**

- The DOM structure never changes. Every presentation lives exactly where the developer placed it.
- Teardown requires removing *two* attributes (`videl-active` and `videl-next`) rather than one — slightly more verbose than the `slot` it replaces.
- Two-attribute state is harder to observe atomically; a `MutationObserver` sees two separate mutations per transition.

#### Option C — Single `videl-state` Attribute (Selected)

A single `videl-state` attribute carries string values mirroring the previous `slot` vocabulary (`"active"`, `"next"`) while being entirely independent of shadow DOM composition. Absence of the attribute (or an empty string) means idle / not participating.

**Why this is preferred over Option B:**

- **Direct mental model continuity.** The previous `slot="active" / slot="next"` pattern is well understood; `videl-state="active" / videl-state="next"` is a one-to-one rename that preserves the semantics.
- **Teardown is one operation.** `removeAttribute('videl-state')` clears all state in a single call, matching the simplicity of the old `removeAttribute('slot')`.
- **Atomic transitions.** A single attribute mutation is what `attributeChangedCallback` and `MutationObserver` both see — no intermediate state where an element carries neither `videl-active` nor `videl-next`.
- **Extensible.** Future values (`"buffering"`, `"error"`, `"paused"`) slot naturally into the same attribute without adding new attributes.
- **CSS selectors are readable.** `[videl-state="active"]` is unambiguous and self-documenting.

---

## Decision

**Adopt Option C.** A single `videl-state` attribute on each element carries its current participation state. The `slot` attribute is reserved exclusively for visual composition (projecting light-DOM children into a parent's shadow root for layout purposes). The two concerns — playback state and DOM presentation — are now fully independent.

---

## Detailed Design

### 1. The `videl-state` Attribute

`videl-state` is a string-valued attribute set by a parent element on its children to communicate their current role. The defined values are:

| Value | Meaning |
|-------|---------|
| `"active"` | This element is the currently active participant (playing, rendering, buffering). |
| `"next"` | This element is preloading / prefetching in anticipation of becoming active. |
| *(absent / removed)* | This element is idle — not participating in the current session. |

The attribute is written by the *parent* and read by the *child's own* `attributeChangedCallback`. This is the same ownership model as `slot` today. `attributeChangedCallback` fires only on the element whose own `observedAttributes` list includes `videl-state`; setting it on a `<videl-presentation>` does not trigger the callback on any descendant `<videl-period>` child — each element responds only to its own attribute mutations.

### 2. State Table Across the Hierarchy

| Element | Set by | Values used | Cardinality |
|---------|--------|-------------|-------------|
| `<videl-presentation>` | `<videl-player>` | `active`, `next` | PickOne — at most one active, one next at any time |
| `<videl-period>` | `<videl-presentation>` | `active`, `next` | PickOne — sequential periods within a presentation |
| `<videl-adaptation-set>` | `<videl-period>` (future) | `active` | **PickN** — video and audio adaptation sets are both active simultaneously |
| `<videl-representation>` | `<videl-adaptation-set>` (future) | `active` | PickOne per adaptation set — the currently selected quality level |

`<videl-representation>` uses `videl-state="active"` (the selected representation) rather than a separate `videl-state="selected"` value — a representation is either active in the buffer or it is not; the "selected" concept is implied by `active` at this layer.

### 3. Changes to `<videl-player>`

Current:
```ts
presentations[1].setAttribute('slot', 'next');   // prefetch
presEl.setAttribute('slot', 'active');            // activate
pres.removeAttribute('slot');                     // deactivate
```

After:
```ts
presentations[1].setAttribute('videl-state', 'next');   // prefetch
presEl.setAttribute('videl-state', 'active');            // activate
pres.removeAttribute('videl-state');                     // deactivate — one call, same as before
```

The player no longer touches the `slot` attribute of its presentation children at all. Presentations that are consumed inside a larger shadow DOM (e.g. slotted into a `<media-playlist>` wrapper element) continue to carry whatever `slot` value the wrapper requires, independent of playback state.

### 4. Changes to `<videl-presentation>`

The `attributeChangedCallback` currently branches on `slot` values. It changes to branch on `videl-state`:

```ts
// Before
if (name === 'slot') {
  if (value === 'next')   { this.#ensurePopulated(); }
  if (value === 'active') { this.#activateFirstPeriod(); }
  if (value === null)     { this.#fetchController?.abort(); }
}

// After
if (name === 'videl-state') {
  if (value === 'next')   { this.#ensurePopulated(); }
  if (value === 'active') { this.#ensurePopulated().then(() => this.#activateFirstPeriod()); }
  if (value === null)     { this.#fetchController?.abort(); this.#deactivateAllPeriods(); }
}
```

`videlUpdate` currently guards on `getAttribute('slot') === 'active'`. It changes to:

```ts
videlUpdate(state: PlayerState): void {
  if (this.getAttribute('videl-state') !== 'active') return;
  const active = this.#childPeriods.find(
    p => p.getAttribute('videl-state') === 'active'
  );
  if (active) (active as any).videlUpdate(state);
}
```

The shadow DOM render no longer needs `<slot name="active">` or `<slot name="next">` for state distribution. The presentation's shadow root simplifies to a single default slot with a targeted hiding rule:

```html
<style>
  ::slotted(videl-period) { display: none; }
</style>
<slot></slot>
<!-- the presentation element IS the playlist card; no named slots needed -->
```

All light-DOM children — user content (images, headings, etc.) and injected `<videl-period>` children alike — are projected into the composed tree through the default slot. User content is visible by default; period children are hidden by the `::slotted` rule but remain inspectable in DevTools. No `slot` attribute is required on user content.

**OQ-1 resolved:** Periods are projected into the shadow root via the default slot. They are hidden by CSS, not by slot assignment. Future overlays (subtitle renders, chapter markers) can be added as children of the period element and will appear in the composed tree without any shadow-root changes.

### 5. Changes to the PickOne / PickN Mixins

The mixins currently set and remove the `slot` attribute on children. They change to set and remove `videl-state` instead.

#### Option i — Parameterise the mixin factory

```ts
// Each element passes its own child-state attribute name and values
PickOneMixin(Base, { attr: 'videl-state', active: 'active', next: 'next' })
```

The mixin becomes generic: it manages whatever attribute/value pairs it is given, rather than hardcoding `slot`. This keeps the mixin reusable and avoids duplicating the tracking logic.

#### Option ii — Replace with a `ChildStateTracker` helper

The mixins carry internal `#activeChild` / `#nextChild` references to avoid repeated DOM queries. A composition helper (not a mixin) could own this:

```ts
class ChildStateTracker {
  #attr:   string;
  #active: Element | null = null;
  #next:   Element | null = null;

  constructor(attr = 'videl-state') { this.#attr = attr; }

  activate(el: Element): void {
    if (this.#active && this.#active !== el) this.#active.removeAttribute(this.#attr);
    if (this.#next   === el)                 this.#next = null;
    this.#active = el;
    el.setAttribute(this.#attr, 'active');
  }

  preload(el: Element): void {
    if (this.#next && this.#next !== el) this.#next.removeAttribute(this.#attr);
    this.#next = el;
    el.setAttribute(this.#attr, 'next');
  }

  deactivateAll(parent: Element): void {
    for (const child of parent.children) child.removeAttribute(this.#attr);
    this.#active = null;
    this.#next   = null;
  }
}
```

Each element holds a `ChildStateTracker` instance rather than mixing in the behaviour. This is more testable, avoids the prototype-chain surgery currently needed to merge `observedAttributes`, and makes the element code explicit about what it manages.

**Recommendation:** The tracker approach is cleaner and eliminates the `observedAttributes` hack entirely. It is the preferred end state. A pragmatic first step is to parameterise the existing mixin to unblock the player/presentation layer, then replace the mixin with the tracker class in a follow-up.

#### The `observedAttributes` collision problem (resolved)

The current mixins walk the prototype chain to merge `observedAttributes` because they must observe `slot`. After this change, elements no longer observe `slot` at the mixin level — they observe `videl-state`. Since `videl-state` is declared in the element's own `static observedAttributes`, there is no collision to resolve. The prototype-chain walk can be removed entirely.

### 6. CSS Hooks

`videl-state` values are directly styleable as attribute selectors:

```css
/* Dim all playlist cards; brighten only the active one */
videl-presentation                       { opacity: 0.5; transition: opacity 0.2s; }
videl-presentation[videl-state="active"] { opacity: 1.0; }

/* Indicate the prefetching item */
videl-presentation[videl-state="next"]   { outline: 2px dashed #888; }

/* Dim inactive periods in a debug view */
videl-period[videl-state="active"]       { border-left: 3px solid lime; }
```

This is strictly more capable than the previous approach, where `[slot="active"]` was only reachable from *outside* the shadow root of the parent — and only if the parent's shadow root did not encapsulate it.

### 7. Developer Tooling and Debugging

The primary debugging motivation for this change. With `videl-state`:

- DevTools Elements panel shows `videl-state="active"` on the exact element it applies to, in its natural document position. Nothing moves.
- The shadow root of `<videl-presentation>` can render a debug panel that reads `this.getAttribute('videl-state')` directly. The debug overlay is coherent with the actual DOM.
- `<videl-player debug>` propagation can render the `videl-state` value inline in each element's debug overlay — the rendered string *is* the state, no decoding required.
- A `MutationObserver` watching `childList: false, attributes: true, attributeFilter: ['videl-state']` on the player gives a complete real-time log of all state transitions across the element tree. No custom events required.
- Future tooling (a `<videl-inspector>` custom element, a DevTools extension panel) can build on this stable, observable attribute surface.

---

## Migration Path

1. **Add `videl-state` handling, keep slot handling.** `<videl-presentation>` and mixins react to both `slot` and `videl-state`. The player still sets `slot`; tests still pass.
2. **Switch `<videl-player>` to set `videl-state`.** Remove all `slot` manipulation from the player. Update player-level tests to assert `videl-state` values.
3. **Remove `slot` observation from `<videl-presentation>`.** The `slot` branch in `attributeChangedCallback` is deleted. Remove `<slot name="active">` and `<slot name="next">` from the presentation shadow root.
4. **Migrate `<videl-period>`** from `slot="active"` to `videl-state="active"` using the parameterised mixin or `ChildStateTracker`. Update period-level tests.
5. **Clean up mixins.** Remove the `observedAttributes` prototype-chain walk. Parameterise or replace with `ChildStateTracker`.
6. **Propagate down the hierarchy** (future work). Adaptation sets and representations are pump-driven today; they adopt `videl-state` when their own activation logic is built out.

---

## Open Questions

### OQ-1: Period visibility in shadow DOM

With periods no longer slotted into a named slot in the presentation's shadow root, period children live only in the light DOM. This is correct for pump-driven behaviour (the player queries them directly), but if a future feature requires periods to inject shadow-hosted content (time-synced overlays, chapter markers, subtitle renders), a generic `<slot name="periods">` for *composition only* would be needed. **Decision deferred** until that feature is designed. Crucially, such a slot would have no relationship to `videl-state`.

### OQ-2: `ChildStateTracker` vs parameterised mixin

Both paths work. The tracker is the cleaner long-term design. **Recommendation:** parameterise the mixin in the same PR as the `videl-state` migration (low risk), then introduce `ChildStateTracker` in a focused follow-up that can be reviewed and tested independently.

### OQ-3: `slot` attribute on presentations in composed trees

After this change, `<videl-presentation>` ignores `slot` entirely for its own activation. A developer can safely place a presentation inside a third-party web component that assigns `slot` values for layout without accidentally triggering prefetch or activation. **Net improvement**; document explicitly that `slot` on a `<videl-presentation>` is purely a layout hint for the host element.

### OQ-4: Non-sequential and user-driven selection

This ADR establishes the mechanism but not the sequencing policy. Any future playlist controller (shuffle, user-click, branching) simply sets `videl-state="active"` on whichever element should play — DOM position is irrelevant. The presentations are stateless receivers; the sequencing logic belongs entirely in the coordinator element. **This is by design.**

### OQ-5: Stale `videl-state` on player removal

If the player is disconnected mid-transition, a stale `videl-state="active"` attribute could remain on a presentation. The previous `slot` approach had the same problem. The fix is a `disconnectedCallback` on the player that calls `removeAttribute('videl-state')` on all direct presentation children. **Needs implementation** as part of the migration.

### OQ-6: Test surface area

Existing Playwright tests assert `getAttribute('slot') === 'active'` and `getAttribute('slot') === 'next'`. These change to `getAttribute('videl-state') === 'active'` etc. The changes are mechanical but touch a significant portion of the test suite. Consider a grep-based CI lint (`/getAttribute\('slot'\)/` disallowed in test files) to prevent regression.

### OQ-7: `videl-state` attribute name collision with host frameworks

If a developer wraps `<videl-presentation>` in a React or Vue component that also uses an attribute named `videl-state` for its own purposes, a collision occurs. The `videl-` prefix provides reasonable namespace isolation; this is the same protection offered by `aria-*` attributes and is considered acceptable for a first-party element attribute system. If collision is observed in practice, the prefix can be made more specific (e.g. `videlstate` as a single token, or `data-videl-state`), but the `data-` prefix is avoided for element-owned state per the rationale in OQ-8.

### OQ-8: `videl-state` vs `data-videl-state`

`data-*` attributes are by convention for *arbitrary developer data*, not for element-defined state APIs. Using `data-videl-state` would signal "this is an extension point for developers" rather than "this is a first-party state attribute owned by the element". The `videl-*` prefix (without `data-`) is consistent with `aria-*`, `part`, and `exportparts` — attributes that are element-API surfaces, not developer data bags. **Decision: `videl-state` without `data-` prefix.**

---

## Consequences

### Positive

- DOM structure is stable; playlist items never move in the element tree regardless of playback state.
- Playback state is immediately inspectable in DevTools at the element that holds it.
- CSS attribute selectors provide a free, zero-JS styling API for all state values.
- Non-sequential playlists require no architecture changes — just set `videl-state` on the right element.
- Shadow DOM is available for genuine visual composition, fully decoupled from state.
- `slot` attribute on presentations is no longer repurposed; wrapper components can use it for layout freely.
- Teardown is a single `removeAttribute('videl-state')` — parity with the old `removeAttribute('slot')`.
- Transitions are atomic: one attribute mutation, one `attributeChangedCallback` invocation, one `MutationObserver` record.
- The `observedAttributes` prototype-chain hack in mixins is eliminated.

### Negative / Trade-offs

- **Test churn.** All `slot`-based test assertions must be migrated. Mechanical but extensive.
- **Mixin API changes.** The mixin factory signatures change. The mixins are currently internal-only, so the blast radius is contained.
- **`videlUpdate` guard changes.** `getAttribute('slot') === 'active'` becomes `getAttribute('videl-state') === 'active'` everywhere. Grep-and-replace across a small set of files.
- **`observedAttributes` update.** Every element that previously observed `slot` for state must add `videl-state` to its `observedAttributes`. This is additive and low risk.

---

## References

- [DEL-010: Playlist Presentations](../planning/DEL-010-playlist-presentations.md)
- [LEMMA.md](../LEMMA.md) — Element-as-card pattern (the presentation element itself is the playlist card; no wrapper slot required)
- [MDN: Using shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM)
- [MDN: Using templates and slots](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_templates_and_slots)
