/**
 * `VidelBeforeActivateEvent` — a custom event fired by every videl element
 * immediately before its `videl-state` transitions to `"active"`.
 *
 * Modeled exactly on the Service Worker `ExtendableEvent` pattern.
 * Supports async holdback via `waitUntil(promise)`.
 *
 * Enables late-binding setup (DRM config, event listeners, auth token fetches)
 * without timing races.
 */
export class VidelBeforeActivateEvent extends CustomEvent<{ element: Element }> {
  readonly #promises: Promise<unknown>[] = [];

  constructor(element: Element) {
    super('videl:before-activate', {
      bubbles: true,
      composed: true,
      cancelable: false,
      detail: { element } as { element: Element }
    });
  }

  /**
   * Register a promise that must resolve before activation proceeds.
   * Multiple promises may be registered; all must settle before the
   * element proceeds.
   */
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

// ── Activation lifecycle helpers ──────────────────────────────────────────────
// Shared by all videl elements that implement the videl-state="active" pattern.
// Each element has its own #onBecomeActive() continuation, but the before-activate
// event dispatch and error reporting are identical everywhere.

/**
 * Fire the `videl:before-activate` event on `element` and wait for all
 * `waitUntil` promises to settle before returning.
 *
 * Used by every videl element whose `videl-state` transitions to `"active"`.
 */
export async function fireBeforeActivate(element: Element): Promise<void> {
  const event = new VidelBeforeActivateEvent(element);
  element.dispatchEvent(event);
  await event.settled;
}

/**
 * Revert `videl-state` and dispatch `videl:activate:error` on `element`.
 *
 * Called from the `.catch` handler of each element's `#onBecomeActive()` async
 * path when activation fails (e.g. a `waitUntil` promise rejects).
 */
export function dispatchActivateError(element: Element, err: unknown): void {
  element.removeAttribute('videl-state');
  element.dispatchEvent(new CustomEvent('videl:activate:error', {
    bubbles: true,
    composed: true,
    detail: {
      element,
      error: err instanceof Error ? err : new Error(String(err))
    }
  }));
}
