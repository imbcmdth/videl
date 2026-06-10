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
