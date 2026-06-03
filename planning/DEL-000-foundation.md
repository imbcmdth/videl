# DEL-000: Foundation — Shared Types and ManagedSourceBuffer

**Depends on:** nothing  
**Deliverable type:** TypeScript module + unit tests  
**Status:** Implemented

---

## Summary

Two foundational pieces everything else depends on:

1. **`PlayerState`** — the shared state object passed down the pump chain on every tick.
2. **`ManagedSourceBuffer`** — a promise-based wrapper around the browser's event-driven `SourceBuffer` API. Eliminates raw `updateend`/`error` event listeners from all element code, serialises concurrent operations internally, and surfaces errors as rejected promises.

Implement and fully test these before any element work begins.

---

## Part 1: `PlayerState`

```ts
interface PlayerState {
  currentTime:  number;       // seconds; from video.currentTime
  buffered:     TimeRanges;   // from video.buffered
  bandwidth:    number;       // bytes/second — rolling estimate maintained by <videl-player>
  playbackRate: number;       // from video.playbackRate; default 1.0
                              // ABR and lookahead calculations must scale by this value —
                              // at 2× rate the buffer depletes twice as fast
}
```

This type is defined once here and imported everywhere. No element should re-declare it.

---

## Part 2: `ManagedSourceBuffer`

### Why this exists

The browser `SourceBuffer` API is event-driven: `appendBuffer()` returns `undefined`; success fires `updateend` on the SourceBuffer; failure fires `error`. Calling `appendBuffer()` while `sourceBuffer.updating === true` throws `InvalidStateError` synchronously. Writing correct, error-safe append code requires managing these constraints everywhere a buffer is used.

`ManagedSourceBuffer` wraps one `SourceBuffer` and provides a promise-based queue. Callers `await` operations; errors are catchable with `try/catch`. Concurrent calls are serialised automatically — the second `append()` call waits for the first to settle before it starts.

### Public API

```ts
class ManagedSourceBuffer {
  constructor(sourceBuffer: SourceBuffer)

  /** Append bytes. Queued if another operation is in progress. */
  append(data: ArrayBuffer | ArrayBufferView): Promise<void>

  /** Remove buffered range [start, end) in seconds. Queued. */
  remove(start: number, end: number): Promise<void>

  /** Abort the current operation; clears the pending queue; resolves when settled. */
  abort(): Promise<void>

  /**
   * Synchronous. Change the MIME+codecs type of the underlying SourceBuffer.
   * Call before the next append when a codec switch is needed.
   * Throws if the browser does not support SourceBuffer.changeType().
   */
  changeType(type: string): void

  /** True while an async operation is in progress. */
  get updating(): boolean

  /** Live TimeRanges from the underlying SourceBuffer. */
  get buffered(): TimeRanges
}
```

### Internal contract

- Maintain an internal FIFO queue of pending operations `{ kind, args, resolve, reject }`.
- After each operation settles (`updateend` fires), dequeue and start the next.
- On `error` event: reject the current operation's promise; clear the queue (all pending operations are also rejected, as the SourceBuffer state is unknown).
- `abort()`: calls `sourceBuffer.abort()`, clears the queue, resolves after the resulting `updateend`.
- Never call `appendBuffer` or `remove` while `updating === true` — the queue prevents this.

---

## Public Interface Summary

| Export | Kind | Description |
|--------|------|-------------|
| `PlayerState` | interface | Pump state passed to every `update()` call |
| `ManagedSourceBuffer` | class | Promise-based SourceBuffer wrapper |

---

## Functional Acceptance Criteria

### PlayerState
1. `PlayerState` is a TypeScript `interface` (not a `class`) — no runtime cost.
2. All four fields are present and typed correctly.

### ManagedSourceBuffer
3. `append(data)` resolves after `updateend` fires on the underlying SourceBuffer.
4. `append(data)` rejects (with the SourceBuffer `error` event) if the SourceBuffer fires `error`.
5. Two sequential `append()` calls: the second does not call `appendBuffer` until the first's `updateend` has fired.
6. Two concurrent `append()` calls (no await between): both eventually resolve in call order; no `InvalidStateError` is thrown.
7. `remove(start, end)` resolves after `updateend`; rejects on `error`.
8. `abort()` resolves after the abort settles; any queued operations are rejected.
9. `changeType(type)` calls `sourceBuffer.changeType(type)` synchronously; throws if not supported.
10. `updating` getter reflects `sourceBuffer.updating` at all times.
11. `buffered` getter reflects `sourceBuffer.buffered` at all times.
12. After an `error` event, all queued pending operations are rejected (not silently dropped).

---

## Test Approach

**Framework:** Playwright component tests (real browser, real `MediaSource` + `SourceBuffer`).

Setup: create a `MediaSource`, attach to a `<video>` element, open a `SourceBuffer` for a known codec. Wrap it with `ManagedSourceBuffer`.

Key test scenarios:
- Single append: append valid fMP4 bytes; assert promise resolves and `buffered` is non-empty.
- Error handling: append invalid bytes; assert promise rejects.
- Serialisation: call `append()` twice without awaiting; assert second append's `appendBuffer` call only happens after first `updateend`.
- Queue rejection on error: queue two appends; first fails; assert second promise is also rejected.
- `abort()`: queue an append, immediately `abort()`; assert append promise rejects and abort promise resolves.
- `remove()`: buffer some content, call `remove(0, 5)`; assert `buffered` no longer contains that range.
- `changeType()`: call with a supported type string; assert no throw.
