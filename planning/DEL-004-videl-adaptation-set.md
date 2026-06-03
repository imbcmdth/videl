# DEL-004: `<videl-adaptation-set>`

**Depends on:** DEL-000 (ManagedSourceBuffer, PlayerState), DEL-001 (mixins), DEL-003 (`<videl-representation>`)  
**Deliverable type:** Custom element + Playwright tests  
**Status:** Implemented

---

## Summary

Owns a set of `<videl-representation>` children for a single content type (video, audio, or text). Implements ABR: on each pump tick, selects the representation best matching current bandwidth. Receives a `ManagedSourceBuffer` from `<videl-castro>` and distributes it to child representations.

---

## Public Interface

### Attributes (set by parent/parser)

| Attribute | Type | Description |
|-----------|------|-------------|
| `content-type` | `video` \| `audio` \| `text` | Content type; used by parent as the `PickNMixin` grouping key |
| `mime-type` | string | MIME type for this adaptation set (e.g. `video/mp4`) |
| `codecs` | string | Default codec string; inherited by child representations if absent |
| `lang` | string | Language code (for audio/text tracks) |
| `slot` | `next` \| `active` \| *(absent)* | Set by parent. |

### Properties (set by parent)

| Property | Type | Description |
|----------|------|-------------|
| `sourceBuffer` | `SourceBuffer` | Set by `<videl-castro>` before element is activated. Castro is the sole caller of `addSourceBuffer`; this element holds a reference and appends to it. |

### `update(state: PlayerState)`

Called by parent on each pump tick **only when `slot=active`**.

Fields used:

| Field | Used for |
|-------|----------|
| `currentTime` | Forwarded to active `<videl-representation>` |
| `buffered` | Forwarded to active `<videl-representation>` |
| `bandwidth` | ABR decision: select optimal representation |

Behavior on each `update()` call:
1. Run ABR: select the highest-bandwidth `<videl-representation>` whose `bandwidth` attribute does not exceed `state.bandwidth * abrSafetyFactor / state.playbackRate` (default `abrSafetyFactor = 0.8`). Dividing by `playbackRate` accounts for faster buffer consumption at speeds above 1× — at 2× the player needs twice the bandwidth headroom.
2. If the selected representation differs from the currently active one:
   a. Check codec compatibility: call `MediaSource.isTypeSupported(newMimeType + '; codecs="' + newCodecs + '"')`. If supported and the MIME type matches the existing SourceBuffer type, deactivate current and activate the new one.
   b. If the codec requires a type change: call `sourceBuffer.changeType(newMimeAndCodecs)` (this is synchronous; it throws if the type is not supported or the browser lacks support). If it succeeds, proceed with the switch. If it throws, fire `videl:mse:incompatible` upward with `{ contentType, requiredCodecs }` and abort the switch until castro rebuilds.
3. Forward `update(state)` to the currently active `<videl-representation>`.

### Events fired

| Event | Bubbles | Detail | Meaning |
|-------|---------|--------|---------|
| `videl:representation:switched` | yes | `{ from: id, to: id, contentType }` | ABR selected a different representation |
| `videl:done` | yes | (re-bubbles from child) | — |
| `videl:segment:error` | yes | (re-bubbles from child) | — |
| `videl:mse:error` | yes | `{ contentType, reason }` | SourceBuffer unrecoverable after abort+retry; castro should rebuild |
| `videl:mse:incompatible` | yes | `{ contentType, requiredCodecs }` | Codec change requires SourceBuffer type that cannot be served by current MSE setup |

---

## Slot Behavior

| Transition | Behavior |
|------------|----------|
| `unslotted → next` | No prefetch work needed at this level. |
| `unslotted → active` | `sourceBuffer` property must already be set by `<videl-castro>` before this transition. Set `sourceBuffer` on all child representations. Run initial ABR to activate the best representation. |
| `any → unslotted` | Deactivate all child representations (cascade). Do **not** call `removeSourceBuffer` — MSE does not support that reliably mid-stream. |

---

## Functional Acceptance Criteria

1. On activation: `sourceBuffer` property is already set by `<videl-castro>` — no `addSourceBuffer` call here.
2. `sourceBuffer` is forwarded as a property to all child `<videl-representation>` elements before any is activated.
3. On each `update()`: the representation with the highest bandwidth not exceeding `bandwidth × 0.8` is selected.
4. If the ABR selection changes: `videl:representation:switched` fires with correct `from`/`to`/`contentType`.
5. On ABR switch: the previously active representation is deactivated (cascade) before the new one is activated.
6. `update()` is forwarded to the active representation with the full `PlayerState`.
7. `abrSafetyFactor` is configurable (attribute or property).
8. On deactivation: all child representation slots are cleared; `SourceBuffer` reference is cleared but `removeSourceBuffer` is never called.
9. If `sourceBuffer` is not set on activation: fires `videl:mse:error` with `{ contentType, reason: 'missing-sourcebuffer' }`.
10. On `appendBuffer` failure: call `sourceBuffer.abort()` and retry once. If retry fails, fire `videl:mse:error` with `{ contentType, reason }`.

---

## Test Approach

**Framework:** Playwright component tests (real browser, real `MediaSource`).

Setup: mount `<videl-adaptation-set>` with 3 `<videl-representation>` children at different bandwidths (e.g. 500k, 1500k, 4000k). Set `sourceBuffer` property directly (stub SourceBuffer). Use stub representations that record `update()` calls.

Key test scenarios:
- SourceBuffer pre-set: verify activation proceeds without calling `addSourceBuffer`; verify `sourceBuffer` is forwarded to child representations.
- ABR low bandwidth: set `bandwidth=600000`; verify 500k representation selected.
- ABR high bandwidth: set `bandwidth=5000000`; verify 4000k representation selected.
- ABR switch: lower bandwidth mid-stream; verify `videl:representation:switched` fires and previous representation is deactivated.
- Safety factor: verify highest representation not exceeding `bandwidth × 0.8` is chosen (not `bandwidth × 1.0`).
- `update()` forwarding: verify active representation's `update()` is called with correct state.
- Deactivation cascade: remove `slot`; verify all child representations go to `unslotted`.
