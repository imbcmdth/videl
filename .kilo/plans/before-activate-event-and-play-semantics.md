# Plan: `videl:before-activate` Event and `play()`/`pause()` Semantics

## Overview

Two related changes that form a coherent lifecycle contract across the full element
hierarchy:

1. **`VidelBeforeActivateEvent`** — a new custom event fired by every element
   immediately before its `videl-state` transitions to `"active"`. Supports async
   holdback via `waitUntil(promise)`, modeled exactly on the Service Worker
   `ExtendableEvent` pattern. Enables late-binding setup (DRM config, event
   listeners, auth token fetches) without timing races.

2. **`videl-state` on `<videl-player>` + `play()`/`pause()` rewrite** — the player
   gains `videl-state` as an observed attribute, completing the uniform attribute
   contract across all levels. `play()` drives the attribute; the attribute drives
   `#video.play()`. No infinite loop; no `play()` bypass.

---

## LEMMA Alignment

- `videl-state` is an **internal-state attribute** written by videl processes →
  `videl-` prefix required (already the convention at all child levels).
- `VidelBeforeActivateEvent` is part of the **CustomEvent contract** for each
  element type (LEMMA: "Attribute contract + CustomEvent contract per element type").
- `waitUntil` lives on the **event instance** (not in `detail`) — identical shape to
  `ExtendableEvent`, a well-understood platform pattern.
- `#video.play()` vs `this.play()` distinction uses **ES private fields** (`#`)
  per LEMMA convention.

---

## Part 1 — `VidelBeforeActivateEvent`

### 1.1 New class: `src/events.ts` (new file, exported from `src/index.ts`)

```ts
/**
 * Fired by every videl element immediately before its videl-state transitions
 * to "active". Modeled on Service Worker ExtendableEvent:
 *
 *   event.waitUntil(promise)
 *
 * The element awaits all registered promises before proceeding with activation.
 * If any promise rejects, activation is aborted and videl:activate:error fires.
 *
 * waitUntil() lives on the event instance itself (not in detail), matching the
 * ExtendableEvent shape exactly.
 */
export class VidelBeforeActivateEvent extends CustomEvent<{ element: Element }> {
  readonly #promises: Promise<unknown>[] = [];

  constructor(element: Element) {
    super('videl:before-activate', {
      bubbles:   true,
      composed:  true,
      cancelable: false,
      detail: { element },
    });
  }

  /** Register a promise that must resolve before activation proceeds. */
  waitUntil(promise: Promise<unknown>): void {
    this.#promises.push(promise);
  }

  /**
   * Internal — awaited by the dispatching element after dispatchEvent returns.
   * Resolves when all waitUntil promises have settled.
   */
  get settled(): Promise<void> {
    return Promise.all(this.#promises).then(() => undefined);
  }
}
```

**Why `cancelable: false`**: activation cannot be vetoed synchronously — only
delayed. If a consumer wants to block permanently they can pass a never-resolving
promise (not recommended but possible). Keeping `cancelable: false` avoids
`event.preventDefault()` being mistaken for "skip activation".

### 1.2 Shared helper: `#fireBeforeActivate()` pattern

Every element that fires the event uses the same two-line pattern:

```ts
async #fireBeforeActivate(): Promise<void> {
  const event = new VidelBeforeActivateEvent(this as unknown as Element);
  this.dispatchEvent(event);
  await event.settled;
}
```

`attributeChangedCallback` is synchronous and cannot `await` directly. The pattern
is: call `this.#onBecomeActive().catch(err => this.#onActivateError(err))` from
`attributeChangedCallback`, where `#onBecomeActive` is an `async` private method
that calls `#fireBeforeActivate()` then proceeds.

### 1.3 Error event on failed waitUntil

If any `waitUntil` promise rejects, the element dispatches:

```ts
this.dispatchEvent(new CustomEvent('videl:activate:error', {
  bubbles: true, composed: true,
  detail: { element: this, error: err }
}));
```

Activation is aborted. The element does **not** set `videl-state="active"`. The
consumer is responsible for recovery (retry, teardown, error display).

### 1.4 Where the event fires in the hierarchy

| Element | Fires before | Existing activation method |
|---|---|---|
| `videl-player` | Playback starts (`#video.play()`) | New — see Part 2 |
| `videl-presentation` | `#activateFirstPeriod()` | `attributeChangedCallback` value=`"active"` |
| `videl-period` | `#activateAll()` | `attributeChangedCallback` value=`"active"` |
| `videl-adaptation-set` | ABR pump + SourceBuffer distribution | `attributeChangedCallback` value=`"active"` |

> **`videl-state="next"` does NOT fire `videl:before-activate`** — prefetch is a
> silent optimisation, not a user-visible lifecycle transition. Only `"active"`
> triggers the event.

### 1.5 Modifications per element

#### `videl-presentation.ts`

Current `attributeChangedCallback` value=`"active"` path:
```ts
// Before (synchronous):
if (value === 'active') {
  this.#activateFirstPeriod();  // or ensurePopulated().then(...)
}
```

After:
```ts
if (value === 'active') {
  this.#onBecomeActive().catch(err => this.#onActivateError(err));
}

async #onBecomeActive(): Promise<void> {
  if (this.src && !this.hasAttribute('videl-populated')) {
    await this.#ensurePopulated();
    if (this.getAttribute('videl-state') !== 'active') return; // aborted
  }
  await this.#fireBeforeActivate();
  this.#activateFirstPeriod();
}
```

The `ensurePopulated` call stays before `#fireBeforeActivate` so that by the time
consumers receive the event, the presentation's full child tree (periods, adaptation
sets with their `protection` attributes, etc.) is already in the DOM and inspectable.

#### `videl-period.ts`

```ts
if (value === 'active') {
  this.#onBecomeActive().catch(err => this.#onActivateError(err));
}

async #onBecomeActive(): Promise<void> {
  await this.#fireBeforeActivate();
  this.#activateAll();
}
```

#### `videl-adaptation-set.ts`

```ts
if (value === 'active') {
  this.#onBecomeActive().catch(err => this.#onActivateError(err));
}

async #onBecomeActive(): Promise<void> {
  await this.#fireBeforeActivate();
  // ... existing sourceBuffer distribution + ABR setup ...
}
```

### 1.6 Usage examples

**DRM config with async token fetch (primary motivation):**

```js
player.addEventListener('videl:before-activate', (event) => {
  const { element } = event.detail;
  if (element.tagName === 'VIDEL-PRESENTATION') {
    event.waitUntil(
      fetchAuthToken().then(token => {
        element.drmConfig = {
          'com.widevine.alpha': {
            serverUrl: 'https://license.example.com/wv',
            httpRequestHeaders: { Authorization: `Bearer ${token}` }
          }
        };
      })
    );
  }
});
```

**Late event binding per presentation:**

```js
player.addEventListener('videl:before-activate', ({ detail: { element } }) => {
  if (element.tagName === 'VIDEL-PRESENTATION') {
    element.addEventListener('videl:done', myAnalyticsHandler);
  }
});
```

**Inspecting the presentation tree before activation (protection attrs already set):**

```js
player.addEventListener('videl:before-activate', ({ detail: { element } }) => {
  if (element.tagName === 'VIDEL-PRESENTATION') {
    const isEncrypted = !!element.querySelector('[protection]');
    console.log('Encrypted content:', isEncrypted);
  }
});
```

---

## Part 2 — `videl-state` on `<videl-player>` and `play()`/`pause()` rewrite

### 2.1 Motivation

Currently `<videl-player>` has no `videl-state` attribute. It is the only element
in the hierarchy that does not follow the uniform attribute contract. This also
means `play()` bypasses the `videl:before-activate` lifecycle entirely.

Adding `videl-state` to the player makes the semantics consistent:

| `videl-state` | Meaning at player level |
|---|---|
| `"active"` | Playback is active (playing or attempting to play) |
| absent | Playback is stopped / paused |

### 2.2 The attribute-driven `play()` loop problem and its resolution

**The loop that must not happen:**
```
play() → sets attribute → attributeChangedCallback → calls play() → sets attribute → ...
```

**The resolution:**
`play()` sets the attribute. `attributeChangedCallback` calls `this.#video.play()`
— the **native** video element's method, not `this.play()`. The chain is strictly
one-directional:

```
play()           →  setAttribute('videl-state', 'active')
                          ↓
attributeChangedCallback  →  this.#video.play()   ← native, not this.play()
```

`this.#video.play()` does not set any attribute. No cycle.

### 2.3 `observedAttributes` change

Add `'videl-state'` to `VidelPlayer.observedAttributes`:

```ts
static observedAttributes = [
  'src', 'tick-ms', 'buffer-ahead', 'time-shift-buffer-depth-default',
  'videl-state'   // ← new
];
```

### 2.4 `attributeChangedCallback` additions

```ts
} else if (name === 'videl-state') {
  if (value === 'active' && old !== 'active') {
    this.#onBecomeActive().catch(err => this.#onActivateError(err));
  } else if (value !== 'active' && old === 'active') {
    // Pause: direct call to native video — no before-activate event for deactivation.
    this.#video.pause();
    this.removeAttribute('videl-user-inactive');
  }
}
```

### 2.5 `#onBecomeActive()` on `videl-player`

```ts
async #onBecomeActive(): Promise<void> {
  await this.#fireBeforeActivate();
  // Only call #video.play() here — NOT this.play() — breaking any potential loop.
  this.#video.play().catch(() => {});
}
```

### 2.6 `play()` rewrite

`HTMLVideoElement.play()` returns `Promise<void>` that resolves when playback
actually starts. The current `play()` delegates directly: `return this.#video.play()`.

After this change, `#video.play()` is deferred through the async
`#fireBeforeActivate()` chain, so `play()` cannot directly return that promise.
Instead it returns a `Promise<void>` that resolves on the `'playing'` event and
rejects on `'error'` — which is semantically identical to what `HTMLVideoElement.play()`
does anyway:

```ts
play(): Promise<void> {
  // Setting the attribute triggers attributeChangedCallback → #onBecomeActive()
  // → #fireBeforeActivate() → #video.play(). We cannot return that deferred
  // promise directly, so we resolve on 'playing' / reject on 'error'.
  if (this.getAttribute('videl-state') !== 'active') {
    this.setAttribute('videl-state', 'active');
  } else {
    // Already active but paused (e.g. after autoplay block) — try directly.
    this.#video.play().catch(() => {});
  }
  return new Promise<void>((resolve, reject) => {
    const onPlaying = () => { cleanup(); resolve(); };
    const onError   = () => { cleanup(); reject(this.#video.error ?? new Error('play failed')); };
    const cleanup   = () => {
      this.#video.removeEventListener('playing', onPlaying);
      this.#video.removeEventListener('error',   onError);
    };
    this.#video.addEventListener('playing', onPlaying, { once: true });
    this.#video.addEventListener('error',   onError,   { once: true });
  });
}
```

### 2.7 `pause()` rewrite

```ts
pause(): void {
  // Remove the attribute → attributeChangedCallback sees old='active', value≠'active'
  // → calls this.#video.pause() directly.
  this.removeAttribute('videl-state');
}
```

### 2.8 `videl:before-activate` on `<videl-player>` — what it fires before

At the player level, `videl:before-activate` fires before `#video.play()` is
called. This is the hook for any setup that must complete before playback begins,
regardless of which presentation is active:

```js
player.addEventListener('videl:before-activate', (event) => {
  if (event.detail.element === player) {
    // Fires before every play() call on the player itself.
    // e.g. check parental controls, log analytics session start, etc.
    event.waitUntil(checkParentalControls());
  }
});
```

### 2.9 `connectedCallback` / `#activatePlaylist` interaction

Currently `connectedCallback` calls `#activatePlaylist()` which calls
`#activatePresentation()` directly, and separately calls `#video.play()` if
`wasPlaying`. After this change:

- `#activatePlaylist()` / `#activatePresentation()` are unaffected — they manage
  MSE setup and presentation `videl-state`, not the player's own `videl-state`.
- `#video.play()` calls in the player (e.g. `#onPresentationDone`) remain as
  `this.#video.play().catch(() => {})` — they bypass the player-level
  `videl:before-activate` intentionally, since they are continuations of an
  already-active playback session, not new play initiations.
- Only `play()` (the public method) and the `videl-state="active"` attribute
  path trigger the player-level `videl:before-activate`.

### 2.10 `#onUiPlayPause` update

The existing internal handler calls `this.#video.play()` / `this.#video.pause()`
directly. After this change it should go through the public methods to maintain
attribute consistency:

```ts
#onUiPlayPause = (): void => {
  if (this.#video.paused) {
    this.play().catch(() => {});   // sets attribute, fires before-activate
  } else {
    this.pause();                  // removes attribute, pauses video
  }
};
```

---

## Part 3 — `videl:activate:error` event

Any element that fires `videl:before-activate` must also handle rejection:

```ts
#onActivateError(err: unknown): void {
  this.removeAttribute('videl-state');   // revert — not active
  this.dispatchEvent(new CustomEvent('videl:activate:error', {
    bubbles: true, composed: true,
    detail: {
      element: this as unknown as Element,
      error: err instanceof Error ? err : new Error(String(err))
    }
  }));
}
```

The player listens for `videl:activate:error` (bubbling up from any level) and
can surface it to the consumer via its own `videl:mse:error` handling or a
dedicated error event.

---

## File Changes

| File | Change |
|---|---|
| `src/events.ts` | **New** — `VidelBeforeActivateEvent` class |
| `src/elements/videl-player.ts` | Add `videl-state` to `observedAttributes`; rewrite `play()`/`pause()`; add `#onBecomeActive`, `#fireBeforeActivate`, `#onActivateError`; update `#onUiPlayPause` |
| `src/elements/videl-presentation.ts` | Replace synchronous activation with `#onBecomeActive` async path; add `#fireBeforeActivate`, `#onActivateError` |
| `src/elements/videl-period.ts` | Same async activation pattern |
| `src/elements/videl-adaptation-set.ts` | Same async activation pattern |
| `src/index.ts` | Export `VidelBeforeActivateEvent` from `./events` |

---

## Implementation Order

1. `src/events.ts` — `VidelBeforeActivateEvent` (no dependencies)
2. `videl-adaptation-set.ts` — leaf activation, simplest async path to validate the pattern
3. `videl-period.ts`
4. `videl-presentation.ts` — includes the `#ensurePopulated` ordering concern
5. `videl-player.ts` — `videl-state`, `play()`/`pause()` rewrite, `#onUiPlayPause`
6. `src/index.ts` — export

---

## Notes on DRM Plan Interaction

The DRM plan (separate) references `videl:before-activate` as the mechanism for
setting `drmConfig` on `<videl-presentation>` elements before activation. That plan
depends on this one being implemented first. No changes to this plan's scope are
needed for DRM — the event is general-purpose and DRM config is just one consumer.
