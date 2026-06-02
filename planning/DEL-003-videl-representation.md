# DEL-003: `<videl-representation>`

**Depends on:** DEL-000 (ManagedSourceBuffer, PlayerState), DEL-001 (mixins), DEL-002 (`<videl-segment>`)  
**Deliverable type:** Custom element + Playwright tests

---

## Summary

Owns a set of `<videl-segment>` children for a single quality level. On each pump tick, selects and promotes the correct segment based on `currentTime` and buffer state. Handles seek and ABR-switch by resolving segment by time, not by DOM position.

---

## Public Interface

### Attributes (set by parent/parser)

| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | string | Representation ID from the manifest |
| `bandwidth` | number | Bitrate in bits/second |
| `width` | number | Video width (if video) |
| `height` | number | Video height (if video) |
| `codecs` | string | Codec string (e.g. `avc1.64001f`) |
| `mime-type` | string | Full MIME type (resolved from parent if absent) |
| `initialization-url` | string | Absolute URL of the initialization segment (fMP4 `moov` box). Set by parser. Required before any media segment can be appended. |
| `initialization-byte-range` | string | Optional. `start-end` byte range for the init segment within a multi-segment file (e.g. `SegmentBase` mode). Omit for full resource. |
| `slot` | `next` \| `active` \| *(absent)* | Set by parent. |

### Properties (set by parent)

| Property | Type | Description |
|----------|------|-------------|
| `sourceBuffer` | `ManagedSourceBuffer` | Passed down from `<videl-adaptation-set>`. Forwarded to active `<videl-segment>` children. |

### `update(state: PlayerState)`

Called by parent on each pump tick **only when `slot=active`**.

Fields used:

| Field | Used for |
|-------|----------|
| `currentTime` | Select which segment covers the playhead; detect if buffer is running low |
| `buffered` | Determine how far ahead is already buffered; avoid re-fetching buffered ranges |

Behavior on each `update()` call:
1. Find the segment whose `start-time ≤ currentTime < start-time + duration`.
2. If that segment is not yet `active`, deactivate the current active segment and activate the target.
3. Find the segment immediately following the active one. If it is `unslotted` and not yet buffered, set it to `next`.
4. If `currentTime` is within a configurable lookahead threshold (default: `3 × segment duration × playbackRate`) of the buffer edge, ensure `next` is set. Scaling by `playbackRate` ensures the lookahead remains correct when playing faster than 1×.

### Events fired

| Event | Bubbles | Detail | Meaning |
|-------|---------|--------|---------|
| `videl:done` | yes | (from child, re-bubbles) | Segment appended; bubbles naturally to parent |
| `videl:segment:error` | yes | (from child, re-bubbles) | Segment failed |

`<videl-representation>` does not fire its own domain events — it lets segment events bubble through.

---

## Slot Behavior

| Transition | Behavior |
|------------|----------|
| `unslotted → next` | Fetch the initialization segment from `initialization-url` (with `Range` header if `initialization-byte-range` is set) and `await sourceBuffer.append(initBytes)`. The init segment is an fMP4 `moov` box required by MSE before any media segments can be appended. |
| `unslotted → active` | If init segment not already appended: fetch and append inline. Then begin pumping via `update()`. |
| `any → unslotted` | Deactivate all child `<videl-segment>` elements (cascade). |

---

## Functional Acceptance Criteria

1. On `update()`: the segment whose time range covers `currentTime` is activated.
2. On `update()` after a seek: the correct segment for the new `currentTime` is activated even if it is not the next sibling (time-based lookup, not positional).
3. On `update()`: the segment immediately following the active one is set to `slot=next` if it is not already buffered.
4. Already-buffered segments (as reported by `buffered`) are not re-fetched or re-activated.
5. `sourceBuffer` is forwarded to each child `<videl-segment>` before that child is slotted.
6. On `slot=next`: the initialization segment is fetched from `initialization-url` and appended to `sourceBuffer` before the element is considered ready.
6a. `initialization-byte-range` is used as a `Range: bytes=start-end` header when set.
7. On deactivation: all child segment slots are cleared synchronously (cascade).
8. Receiving `videl:done` from a child does not advance to the next segment automatically — that is driven by `update()` on the next tick.

---

## Test Approach

**Framework:** Playwright component tests (real browser).

Setup: mount `<videl-representation>` with 3–5 manually constructed `<videl-segment>` children (use mock `sourceBuffer` with a stub `appendBuffer`). Call `update()` directly to drive behavior.

Key test scenarios:
- Sequential pump: call `update({ currentTime: 0, ... })`; verify segment 0 is `active`, segment 1 is `next`.
- Seek: call `update({ currentTime: 30, ... })`; verify segment covering t=30 is activated regardless of prior state.
- Already-buffered skip: set `buffered` to include segment 1's range; verify segment 1 is skipped and segment 2 gets `slot=next`.
- Init segment fetch: verify `slot=next` triggers init segment request before any segment fetch.
- Deactivation cascade: remove `slot` from `<videl-representation>`; verify all child segments return to `unslotted`.
