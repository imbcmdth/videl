# DEL-006: `<videl-presentation>`

**Depends on:** DEL-001 (mixins), DEL-005 (`<videl-period>`)  
**Deliverable type:** Custom element + Playwright tests

---

## Summary

The MPD root element. Holds top-level manifest attributes and advances sequentially through its `<videl-period>` children. When used in a playlist context (multiple `<videl-presentation>` siblings under `<videl-castro>`), its `slot=next` behavior prefetches the next manifest.

---

## Public Interface

### Attributes (set by parser)

| Attribute | Type | Description |
|-----------|------|-------------|
| `src` | string | Original MPD URL (used for prefetch of next presentation, if applicable) |
| `media-presentation-duration` | number | Total duration in seconds (`static` type only) |
| `min-buffer-time` | number | Minimum buffer time in seconds |
| `type` | `static` \| `dynamic` | VOD vs live |
| `slot` | `next` \| `active` \| *(absent)* | Set by parent. |

### Properties (set by parent)

None. `<videl-castro>` sets `sourceBuffer` directly on `<videl-adaptation-set>` elements (see ADR-0001). `<videl-presentation>` does not handle `MediaSource` or `SourceBuffer` distribution.

### `update(state: PlayerState)`

Called by parent on each pump tick **only when `slot=active`**.

Fields used: all — forwarded in full to the active `<videl-period>`.

Behavior on each `update()` call:
1. Forward `update(state)` to the active `<videl-period>`.
2. `SequentialMixin` listens for `videl:done` from direct `<videl-period>` children and advances to the next period automatically.
3. If no periods remain: fire `videl:done` (with `detail.src` to identify the presentation).

### Events fired

| Event | Bubbles | Detail | Meaning |
|-------|---------|--------|---------|
| `videl:done` | yes | `{ src }` | All periods completed; also re-bubbles from child periods/segments |
| `videl:segment:error` | yes | (re-bubbles from child) | — |

---

## Slot Behavior

Mixin: `SequentialMixin(PickOneMixin(LitElement))` — completion event: `videl:done`, filtered to direct `<videl-period>` children (`event.target.parentElement === this`).

| Transition | Behavior |
|------------|----------|
| `unslotted → next` | If `src` attribute is present: fetch and parse the MPD at `src`, populate own children. (Enables playlist prefetch.) |
| `unslotted → active` | If not yet populated (skipped `next`): fetch and parse inline. Forward `mediaSource` to first period and activate it. |
| `any → unslotted` | Deactivate active period (cascade). |

---

## Functional Acceptance Criteria

1. On activation: the first `<videl-period>` child receives `slot=active`.
2. On activation: the first `<videl-period>` child receives `slot=active`. `<videl-castro>` has already set `sourceBuffer` on its adaptation set children before this transition.
3. On `videl:done` from the active period (direct child only): the next sibling period is activated.
4. When the last period completes: `videl:done` fires with `detail.src`.
5. `update()` is forwarded to the active period on every tick.
6. On `slot=next` with `src` set: an HTTP request is made to the `src` URL and children are populated before activation.
7. On direct `unslotted → active`: fetch + parse happens inline; playback starts after first period is ready.
8. On deactivation: active period is deactivated (cascade).

---

## Test Approach

**Framework:** Playwright component tests (real browser).

Setup: mount `<videl-presentation>` with 2 stub `<videl-period>` children. Use stub periods that record calls and dispatch `videl:done` when instructed.

Key test scenarios:
- Sequential period advance: dispatch `videl:done` from period 0; verify period 1 becomes `slot=active`.
- Presentation done: dispatch `videl:done` from final period; verify `videl:done` fires with `detail.src`.
- Descendant filtering: dispatch `videl:done` from a grandchild element; verify no period advancement occurs.
- Activation order: verify the first period receives `slot=active` on presentation activation.
- Prefetch (`slot=next`): mock the fetch of an MPD URL; verify children are populated before activation.
- Direct activation (no prefetch): verify inline fetch + parse works.
- Deactivation cascade: remove `slot`; verify active period returns to `unslotted`.
