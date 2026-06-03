# DEL-002: `<videl-segment>`

**Depends on:** DEL-000 (ManagedSourceBuffer, PlayerState), DEL-001 (mixins — for deactivation cascade contract)  
**Deliverable type:** Custom element + Playwright tests  
**Status:** Implemented

---

## Summary

The execution leaf of the tree. An abstraction over fetching: given a URL and optional byte range, deliver bytes to a `SourceBuffer`. Manages its own fetch lifecycle including abort on deactivation.

---

## Public Interface

### Attributes (set by parent/parser)

| Attribute | Type | Description |
|-----------|------|-------------|
| `url` | string | Absolute URL of the segment |
| `byte-range` | string | Optional. Format: `start-end` (inclusive). Omit for full resource. |
| `start-time` | number | Presentation start time in seconds |
| `duration` | number | Segment duration in seconds |
| `slot` | `next` \| `active` \| *(absent)* | Set by parent. Drives fetch/append lifecycle. |

### Properties (set by parent)

| Property | Type | Description |
|----------|------|-------------|
| `sourceBuffer` | `ManagedSourceBuffer` | Set by parent before element is slotted. Required for `slot=active`. A `ManagedSourceBuffer` wrapping the raw `SourceBuffer`; see DEL-000. |

### `videlUpdate(state: PlayerState)`

Not called on `<videl-segment>`. It is the leaf — it receives no pump calls.

### Events fired

| Event | Bubbles | Detail | Meaning |
|-------|---------|--------|---------|
| `videl:done` | yes | `{ startTime, duration }` | Bytes successfully appended to SourceBuffer |
| `videl:segment:error` | yes | `{ error: Error }` | Fetch or append failed |

---

## Slot Behavior

| Transition | Behavior |
|------------|----------|
| `unslotted → next` | Begin `fetch()` via internal `AbortController`. Hold bytes in memory on completion. |
| `unslotted → active` | Fetch (if not already prefetched), then `await sourceBuffer.append(bytes)`. Fire `videl:done` on resolution; fire `videl:segment:error` on rejection. |
| `next → active` | If prefetch is complete: `await sourceBuffer.append(bytes)` immediately. If still in-flight: await the fetch, then append. |
| `any → unslotted` | Abort any in-flight fetch immediately via `AbortController.abort()`. Discard any held bytes. |

---

## Functional Acceptance Criteria

1. On `slot=next`: a `fetch()` request is issued for the configured `url` (with `Range` header if `byte-range` is set).
2. On `slot=active` after successful prefetch: `await sourceBuffer.append(bytes)` is called; `videl:done` fires on resolution.
3. On `slot=active` without prior prefetch (direct activation): fetch is performed inline, then `await sourceBuffer.append(bytes)`; `videl:done` fires on resolution.
4. On `slot` removed while fetch is in-flight: the fetch is aborted via `AbortController`; no append occurs; no event fires.
5. On `slot` removed after prefetch complete but before append: bytes are discarded; no append occurs.
6. On fetch failure: `videl:segment:error` fires with the error; no append attempt is made.
7. On `sourceBuffer.append()` rejection: `videl:segment:error` fires with the error.
8. `sourceBuffer` property must be set before `slot=active`; if absent, fires `videl:segment:error`.
9. `videl:done` detail includes `startTime` and `duration` matching the element's attributes.
10. Re-slotting after deactivation (unslotted → next again) works correctly — previous abort state is cleared.

---

## Test Approach

**Framework:** Playwright component tests (real browser, real `MediaSource` / `SourceBuffer`).

Setup: create a `MediaSource`, attach to a `<video>` element, open a `SourceBuffer` for a known codec. Mount `<videl-segment>` with test fixture segment URLs (small real ISOBMFF/fMP4 segments served locally by the test runner).

Key test scenarios:
- Prefetch path: set `slot=next`, wait for fetch, then set `slot=active`; assert `videl:done` fires and bytes appear in buffer.
- Direct activation path: set `slot=active` without prior `slot=next`; assert same outcome.
- Abort on deactivation: set `slot=next`, immediately remove `slot` before fetch completes (intercept with a delayed mock server); assert no `appendBuffer` call and no event.
- Fetch error: point `url` at a 404; assert `videl:segment:error`.
- Missing `sourceBuffer`: activate without setting property; assert `videl:segment:error`.
- Re-slot after abort: verify second activation works cleanly.
