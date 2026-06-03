# DEL-001: Selection Mixins

**Depends on:** nothing  
**Deliverable type:** TypeScript library code + unit tests  
**Status:** Implemented

---

## Summary

Three composable class mixins that implement all slot selection and lifecycle management. Every element in the tree is built on top of these. Getting them right and well-tested is the foundation everything else depends on.

---

## Mixins to Implement

### `PickOneMixin(superclass)`
Manages slot lifecycle for elements that activate exactly one child at a time.

- At most one child holds `slot=active`; at most one holds `slot=next`. Both enforce mutually exclusive.
- Provides `activateChild(el)` and `preloadChild(el)` methods for the subclass to call internally (these are not called by external parents — the parent sets the element's own `slot` attribute, and the subclass responds via `attributeChangedCallback`).
- On deactivation (own `slot` attribute removed): synchronously strips `slot` from all currently-slotted children before completing transition. This must be synchronous.

### `PickNMixin(superclass)`
Manages slot lifecycle for elements that activate multiple children simultaneously, grouped by a key.

- Allows one `slot=active` child per key simultaneously (e.g., one for `video`, one for `audio`); one `slot=next` child per key simultaneously (mirrors `active` semantics).
- Subclass implements `getSlotKey(child: Element): string` to map a child element to its key.
- **Lazy shadow slot creation:** on the first `activateChild` or `preloadChild` call for a given key, the mixin creates `<slot name="${key}-active">` and `<slot name="${key}-next">` in the shadow root. No upfront key declaration is needed. A period with only video+audio children will only ever have those two slot pairs — text slots are never created.
- Same deactivation cascade contract as `PickOneMixin`.

### `SequentialMixin(superclass)`
Implements sequential advancement strategy. Composable on top of `PickOneMixin` or `PickNMixin`.

- On receiving `videl:done` (or the configurable completion event name) bubbled from a child: promotes the next DOM sibling to `slot=next`, then advances the current `slot=next` to `slot=active`. Filters to direct children only (`event.target.parentElement === this`) so that `videl:done` events from deeper descendants do not trigger spurious advancement.
- Does nothing if no next sibling exists (end of sequence).
- Exposes `completionEvent` property so subclasses can configure which event name triggers advancement (default: `videl:done`).

---

## LitElement Wiring

These mixins are designed to compose with `LitElement`. A few non-obvious wiring requirements:

**Shadow root:** LitElement creates a shadow root automatically. The mixins assume `this.shadowRoot` exists when `activateChild`/`preloadChild` are first called. Do not call these before `connectedCallback`.

**Observing the `slot` attribute:** The mixin must react when the element's own `slot` attribute is removed (deactivation cascade). Declare `slot` as a LitElement reactive property so `attributeChangedCallback` fires:
```ts
@property({ reflect: true }) slot?: string;
```
The mixin hooks into the property's setter to trigger deactivation. Subclasses must not shadow this property.

**`activateChild(el)` mechanics — PickOneMixin:** Sets `el.slot = 'active'` on the child. The browser then assigns `el` to `<slot name="active">` in this element's shadow root. Setting the same slot on a second child first removes it from the previous child.

**`activateChild(el)` mechanics — PickNMixin:** Calls `getSlotKey(el)` to determine the key (e.g. `'video'`), lazily creates `<slot name="video-active">` in the shadow root if it does not exist, then sets `el.slot = 'video-active'` on the child.

**`preloadChild(el)` mechanics:** Same as above but uses the `next` slot name (`'next'` for PickOne, `'${key}-next'` for PickN).

**Typical composition pattern:**
```ts
class MyElement extends SequentialMixin(PickOneMixin(LitElement)) {
  static properties = { slot: { type: String, reflect: true } };

  attributeChangedCallback(name, old, next) {
    super.attributeChangedCallback(name, old, next);
    // mixin hooks handled via super chain
  }

  protected activate() {
    // called by subclass when own slot becomes active
    this.activateChild(this.firstElementChild);
  }
}
```

---

## Public Interface

These mixins are internal — they have no parent-facing `update()` call and fire no domain events of their own.

| What | Detail |
|------|--------|
| Methods provided to subclass | `activateChild(el)`, `preloadChild(el)`, `deactivateAll()` — called internally by the subclass, never by a parent element |
| Observed on self | `slot` attribute (triggers deactivation cascade when removed) |
| Shadow slots (`PickOneMixin`) | `<slot name="active">`, `<slot name="next">` — declared statically in shadow root |
| Shadow slots (`PickNMixin`) | `<slot name="${key}-active">`, `<slot name="${key}-next">` — created lazily on first use of each key |
| Events fired | none — slot state is observable via the native Shadow DOM `slotchange` event on the element's named `<slot>` elements |

---

## Functional Acceptance Criteria

1. `PickOneMixin`: setting `slot=active` on a second child automatically removes `slot=active` from the first.
2. `PickOneMixin`: setting `slot=next` on a second child automatically removes `slot=next` from the first.
3. `PickOneMixin` / `PickNMixin`: removing the parent's own `slot` attribute synchronously removes `slot` from all slotted children before any microtask runs.
4. `PickNMixin`: two children with different `getSlotKey` values can both hold `slot=active` simultaneously.
5. `PickNMixin`: two children with the same `getSlotKey` value cannot both hold `slot=active`; the newer assignment wins.
5a. `PickNMixin`: two children with different `getSlotKey` values can both hold `slot=next` simultaneously.
5b. `PickNMixin`: two children with the same `getSlotKey` value cannot both hold `slot=next`; the newer assignment wins.
6. `SequentialMixin`: on child completion event, the next DOM sibling is promoted through `next → active` in order.
7. `SequentialMixin`: if no next sibling exists, no error is thrown and no slot change occurs.
8. `SequentialMixin`: a child going directly `unslotted → active` (skipping `next`) must not break the sequential advancement logic.
9. Deactivation cascade is recursive: deactivating a parent deactivates its children, which deactivates their children, and so on synchronously.
10. `PickOneMixin`: native `slotchange` fires on `<slot name="active">` and `<slot name="next">` on every transition.
10a. `PickNMixin`: native `slotchange` fires on the appropriate `<slot name="${key}-active">` or `<slot name="${key}-next">` element on every transition.
11. `PickNMixin`: shadow slots for a key are created lazily — a key's slot pair does not exist in the shadow root until the first child with that key is activated or preloaded.

---

## Test Approach

**Framework:** Playwright component tests (real browser).

Register minimal test custom elements (e.g., `<test-pick-one>`, `<test-pick-n>`, `<test-sequential>`) that apply the mixins. Mount them with child `<div slot="...">` or equivalent test children.

Key test scenarios:
- Slot mutual exclusion (criteria 1–2, 5)
- Deactivation cascade depth (criteria 3, 9) — verify synchronously using `MutationObserver` records
- `PickNMixin` multi-active (criteria 4–5)
- `PickNMixin` lazy slot creation: verify slot elements are absent before first activation of a key, present after (criteria 11)
- Sequential advancement: mock child that dispatches `videl:done`; verify next sibling gets promoted (criteria 6–7)
- Direct `unslotted → active` skip: verify works without breaking subsequent sequential advancement (criteria 8)
- `SequentialMixin` descendant filtering: verify that `videl:done` from a grandchild does not trigger advancement (criteria 10)
