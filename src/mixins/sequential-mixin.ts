/**
 * SequentialMixin — implements sequential child advancement strategy.
 * Composable on top of PickOneMixin or PickNMixin.
 *
 * On receiving the configured completion event (default: `videl:done`) bubbled
 * from a direct child:
 *  1. Deactivates the completing child (removes its `slot` attribute).
 *  2. Activates the next DOM sibling (calls `this.activateChild`).
 *  3. Preloads the sibling after that (calls `this.preloadChild`), if present.
 *
 * The event is filtered to direct children only — events from deeper
 * descendants do NOT trigger spurious advancement.
 *
 * `completionEvent` property (default `'videl:done'`) is configurable by
 * subclasses.
 */

import type { Constructor } from './pick-one-mixin';

// Interface the composed base must satisfy (provided by PickOneMixin/PickNMixin).
interface SlotHost {
  activateChild(el: Element): void;
  preloadChild(el: Element): void;
  connectedCallback?(): void;
  disconnectedCallback?(): void;
}

export function SequentialMixin<TBase extends Constructor<HTMLElement & SlotHost>>(Base: TBase) {
  class Sequential extends Base {
    /** Name of the CustomEvent that signals a child has completed. */
    completionEvent: string = 'videl:done';

    #onChildComplete: (event: Event) => void;

    constructor(...args: any[]) {
      super(...args);
      this.#onChildComplete = (event: Event) => {
        const target = event.target as Element;
        // Only react to events from direct children.
        if (!target || target.parentElement !== this) return;

        const next = target.nextElementSibling;

        // Deactivate the completing child.
        target.removeAttribute('videl-state');

        if (!next) return; // End of sequence — nothing to advance to.

        // Activate the next sibling.
        this.activateChild(next);

        // Preload the sibling after that, if any.
        const afterNext = next.nextElementSibling;
        if (afterNext) {
          this.preloadChild(afterNext);
        }
      };
    }

    connectedCallback(): void {
      super.connectedCallback?.();
      this.addEventListener(this.completionEvent, this.#onChildComplete);
    }

    disconnectedCallback(): void {
      this.removeEventListener(this.completionEvent, this.#onChildComplete);
      super.disconnectedCallback?.();
    }
  }

  return Sequential;
}
