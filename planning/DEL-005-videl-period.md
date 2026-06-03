# DEL-005: `<videl-period>`

**Depends on:** DEL-001 (mixins), DEL-004 (`<videl-adaptation-set>`)  
**Deliverable type:** Custom element + Playwright tests  
**Status:** Implemented

---

## Summary

Owns a set of `<videl-adaptation-set>` children. Uses `PickNMixin` to activate one adaptation set per content type simultaneously (video + audio + optional text). Forwards pump ticks to all active adaptation sets.

---

## Public Interface

### Attributes (set by parent/parser)

| Attribute | Type | Description |
|-----------|------|-------------|
| `period-id` | string | Period ID from the manifest |
| `start` | number | Period start time in seconds |
| `duration` | number | Period duration in seconds (absent = open-ended) |
| `slot` | `next` \| `active` \| *(absent)* | Set by parent. |

### Properties (set by parent)

None. `<videl-player>` sets `sourceBuffer` directly on each `<videl-adaptation-set>` child (see ADR-0001). `<videl-period>` does not handle `MediaSource` or `SourceBuffer` distribution.

### `videlUpdate(state: PlayerState)`

Called by parent on each pump tick **only when `slot=active`**.

Fields used: all — forwarded in full to each active `<videl-adaptation-set>`.

Behavior on each `update()` call:
1. Forward `videlUpdate(state)` to all currently active `<videl-adaptation-set>` children.
2. Check if `state.currentTime >= start + duration` (if `duration` is set). If so, fire `videl:done` to signal the period has ended.

### Events fired

| Event | Bubbles | Detail | Meaning |
|-------|---------|--------|---------|
| `videl:done` | yes | `{ periodId }` | `currentTime` has reached the end of this period (also re-bubbles from child segments) |
| `videl:representation:switched` | yes | (re-bubbles from child) | — |
| `videl:segment:error` | yes | (re-bubbles from child) | — |

---

## Slot Behavior

`PickNMixin` grouping key: `content-type` attribute of `<videl-adaptation-set>`.

| Transition | Behavior |
|------------|----------|
| `unslotted → next` | Assign `slot=next` to one adaptation set per unique `content-type` (first in DOM order). No activation yet. |
| `unslotted → active` | Activate one adaptation set per unique `content-type` value (first in DOM order). `sourceBuffer` must already be set on each adaptation set by `<videl-player>` before this transition. |
| `any → unslotted` | Deactivate all active and next-slotted child adaptation sets (cascade). |

**Selection logic:** for each `content-type` group, activate the first child in DOM order. Custom element implementations can override this by overriding `selectAdaptationSet(contentType, candidates)`.

---

## Functional Acceptance Criteria

1. On activation with children of types `video` and `audio`: both are activated simultaneously (`slot=active`).
2. On activation with an additional `text` child: all three are activated simultaneously.
3. Only one adaptation set per `content-type` is `slot=active` at any time.
3a. On `slot=next`: one adaptation set per `content-type` receives `slot=next` simultaneously (video-next and audio-next coexist).
3b. Only one adaptation set per `content-type` is `slot=next` at any time.
4. `sourceBuffer` is set on each `<videl-adaptation-set>` by `<videl-player>` before the period is activated — `<videl-period>` does not set it.
5. `update()` is forwarded to all active adaptation sets on every tick.
6. When `currentTime >= start + duration`: `videl:done` fires exactly once (with `detail.periodId`).
7. On deactivation: all child adaptation set slots are cleared synchronously.
8. `videl:done` (period-level) does not fire if `duration` attribute is absent.
9. Period ordering in the DOM is the authoritative playback order — there is no sorting by `start` attribute.

---

## Test Approach

**Framework:** Playwright component tests (real browser).

Setup: mount `<videl-period>` with stub `<videl-adaptation-set>` children (record `update()` calls and slot changes). Use stub `MediaSource`.

Key test scenarios:
- Multi-activate: verify video + audio children both reach `slot=active`.
- Single content type: verify only one child per content type is active (second video child stays `unslotted`).
- Slot activation order: verify `slot=active` is not set on any adaptation set before its `sourceBuffer` property is present (stub castro sets it upfront in tests).
- `update()` fan-out: call `videlUpdate()`; verify all active children's `update()` was called.
- Period end: call `videlUpdate({ currentTime: start + duration + 0.1 })`; verify `videl:done` fires with correct `detail.periodId`.
- No duration: verify `videl:done` (period-initiated) never fires regardless of `currentTime`.
- Deactivation cascade: remove `slot`; verify all active children return to `unslotted`.
