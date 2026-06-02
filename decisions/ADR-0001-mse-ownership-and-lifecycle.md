# ADR-0001: MSE Ownership and Lifecycle

**Date:** 2026-06-02  
**Status:** Accepted  
**Deciders:** imbcmdth, [Bot]Arch

---

## Context

The MSE stack has three distinct entities — `<video>`, `MediaSource`, and `SourceBuffer` instances — each with different lifetimes and failure modes. Without explicit ownership, recovery from bad states (corrupted SourceBuffer, unexpected MediaSource close, codec incompatibility, content type set change) becomes ad hoc and fragile. This ADR defines who owns what, how ownership is communicated, and what the rebuild path looks like.

---

## Decision

### Ownership

| Entity | Owner | Notes |
|--------|-------|-------|
| `<video>` element | `<videl-castro>` | Permanent; lives in shadow DOM for the lifetime of the element |
| `MediaSource` | `<videl-castro>` | Sole creator and destroyer. No other element calls methods on it directly. Object URL created by castro; revoked only after the MediaSource is closed. |
| `SourceBuffer` instances | `<videl-castro>` | Sole caller of `addSourceBuffer`. Maintains a `{ contentType → SourceBuffer }` registry. Distributes SourceBuffers to `<videl-adaptation-set>` elements as properties. |

`<videl-adaptation-set>` holds a reference to its assigned SourceBuffer and calls `appendBuffer`/`abort` on it. It does **not** call `addSourceBuffer` or `removeSourceBuffer`.

---

## SourceBuffer Distribution

After MediaSource `sourceopen` fires, castro inspects the active presentation's manifest to determine the required content types and codec strings, then:

1. Calls `addSourceBuffer(mimeType + codecs)` once per required content type.
2. Sets the resulting `SourceBuffer` as a property on the corresponding `<videl-adaptation-set>` element before it is activated.

This is deterministic and centralised — castro always knows the full SourceBuffer set and can rebuild it from the manifest.

---

## Rebuild Triggers

| Trigger | Action |
|---------|--------|
| `src` attribute change | Full teardown — always |
| SourceBuffer `error` event, or unrecoverable state after abort+retry | Full rebuild |
| MediaSource enters `closed` or `ended` unexpectedly | Full rebuild |
| Codec incompatibility on ABR switch | Try `SourceBuffer.changeType()` first; fall back to full rebuild if unavailable or throws |
| Content type set change between presentations (e.g. video+audio → audio-only) | Full rebuild — `removeSourceBuffer` is not reliable mid-stream |

---

## Rebuild Procedure

All steps are `<videl-castro>`'s responsibility. Nothing below castro needs to know a rebuild happened — it receives a fresh SourceBuffer property on re-activation and proceeds normally.

1. Save `video.currentTime`.
2. Synchronously deactivate the presentation cascade — all slots are cleared top-down before any async work begins.
3. If MediaSource is still open, call `MediaSource.endOfStream()`.
4. Revoke the existing object URL (`URL.revokeObjectURL`).
5. Create a new `MediaSource`.
6. Create a new object URL; set `video.src`.
7. Wait for `sourceopen`.
8. Inspect the manifest for required content types and codec strings.
9. Call `addSourceBuffer` for each required content type.
10. Distribute new SourceBuffers to the relevant `<videl-adaptation-set>` elements via properties.
11. Set `video.currentTime` to the saved position.
12. Reactivate the presentation from the current position.

---

## Error Recovery Escalation

### First-line: `<videl-adaptation-set>`

On a failed `appendBuffer`:
1. Call `sourceBuffer.abort()`.
2. Retry the append once.
3. If the retry fails or the SourceBuffer is in an unrecoverable state (e.g. `updating` stuck, `error` event fired), fire `videl:mse:error` upward with `{ contentType, reason }`.

### Quota exceeded: `<videl-representation>`

1. Attempt to remove buffered ranges behind a configurable eviction horizon (default: everything more than 30 seconds behind `currentTime`).
2. If quota is still exceeded after eviction, fire `videl:mse:error` upward.

### Final handler: `<videl-castro>`

Listens for `videl:mse:error` (bubbles). On receipt, executes the full rebuild procedure above.

---

## Codec Change Handling

`<videl-adaptation-set>` detects when an ABR switch selects a representation whose codec string is incompatible with the current SourceBuffer's type:

1. Try `sourceBuffer.changeType(newMimeAndCodecs)` — supported in all modern browsers (Chrome 70+, Firefox 63+, Safari 15.4+).
2. If `changeType` throws or is unavailable, fire `videl:mse:incompatible` upward with `{ contentType, requiredCodecs }`.
3. Castro catches `videl:mse:incompatible` and triggers the full rebuild procedure.

---

## Consequences

**Positive:**
- Single source of truth for MSE state — castro can always fully reconstruct the SourceBuffer set from the manifest.
- Rebuild is a clean, reusable path triggered uniformly regardless of failure cause.
- `<videl-adaptation-set>` is simpler: receives SourceBuffer, appends to it, escalates errors. No MSE lifecycle responsibility.

**Negative:**
- Castro must parse enough manifest structure to know codec strings before `sourceopen` — it cannot delegate this lazily to adaptation sets. This is acceptable since the parser already produces this data.
- The distribution step (setting SourceBuffer properties on adaptation sets) creates a coupling between castro and the adaptation set element names/structure. This is an acceptable tradeoff given they are all part of the same component tree.

---

## Rejected Alternatives

**`<videl-adaptation-set>` calls `addSourceBuffer` directly (original design)**  
Simpler initial path but makes rebuild hard — castro would need to signal down through the tree to recreate SourceBuffers, with no central registry to reason about. Abandoned in favour of centralised ownership.

**Event-based SourceBuffer request (`videl:sourcebuffer:request` fired upward)**  
Clean boundary but creates an awkward synchronous event round-trip at activation time. Rejected in favour of direct property setting by castro after manifest inspection.
