/**
 * PickNMixin — manages `videl-state` lifecycle for elements that activate
 * multiple children simultaneously, grouped by a key (e.g. content type:
 * video/audio).
 *
 * Guarantees:
 *  - At most one child per key holds `videl-state="active"` at any time.
 *  - At most one child per key holds `videl-state="next"` at any time.
 *  - Children with different keys can hold `videl-state="active"` simultaneously.
 *  - When the host's own `videl-state` attribute is removed, all children are
 *    synchronously deactivated (cascade).
 *
 * Subclasses must override `getSlotKey(child)` to map a child element to its
 * grouping key.
 *
 * Methods provided to subclasses:
 *  - `activateChild(el)` — set `videl-state="active"` on el (deactivates previous
 *                          element with the same key first)
 *  - `preloadChild(el)`  — set `videl-state="next"` on el (same per-key exclusivity)
 *  - `deactivateAll()`   — remove `videl-state` from every child that has it
 *
 * NOTE: this mixin no longer creates named shadow slots. The key is used only
 * for internal per-group exclusivity tracking, not as a visible slot name.
 * State is communicated exclusively through `videl-state` (ADR-0002).
 */

import type { Constructor } from './pick-one-mixin';
import { mergeObservedAttributes } from '../utils';
export type { Constructor };

type CEBase = Constructor<
  HTMLElement & {
    connectedCallback?(): void;
    attributeChangedCallback?(name: string, old: string | null, value: string | null): void;
  }
>;

export function PickNMixin<TBase extends CEBase>(Base: TBase) {
  class PickN extends Base {
    #activeByKey: Map<string, Element> = new Map();
    #nextByKey:   Map<string, Element> = new Map();

    static get observedAttributes(): string[] {
      return mergeObservedAttributes(Base, this, ['videl-state']);
    }

    connectedCallback(): void {
      super.connectedCallback?.();
    }

    attributeChangedCallback(name: string, old: string | null, value: string | null): void {
      super.attributeChangedCallback?.(name, old, value);
      if (name === 'videl-state' && value === null) {
        this.deactivateAll();
      }
    }

    /**
     * Override in subclass to map a child element to its grouping key
     * (e.g. `child.getAttribute('content-type') ?? 'video'`).
     */
    getSlotKey(child: Element): string {
      throw new Error('PickNMixin: getSlotKey() must be overridden by the subclass');
    }

    /**
     * Set `videl-state="active"` on `el`. If another child with the same key
     * already holds `videl-state="active"`, it is deactivated first.
     */
    activateChild(el: Element): void {
      const key  = this.getSlotKey(el);
      const prev = this.#activeByKey.get(key);
      const isValidKey = ['text', 'video', 'audio'].indexOf(key) >= 0;
      if (!isValidKey) {
        console.warn(`Skipping activation of child with key "${key}" which is not "text", "video", or "audio". `);
        return;
      }
      if (prev && prev !== el) {
        prev.removeAttribute('videl-state');
      }
      // If this element was tracked as next for this key, clear that.
      if (this.#nextByKey.get(key) === el) {
        this.#nextByKey.delete(key);
      }
      this.#activeByKey.set(key, el);
      el.setAttribute('videl-state', 'active');
    }

    /**
     * Set `videl-state="next"` on `el`. If another child with the same key
     * already holds `videl-state="next"`, it is cleared first.
     */
    preloadChild(el: Element): void {
      const key  = this.getSlotKey(el);
      const prev = this.#nextByKey.get(key);
      if (prev && prev !== el) {
        prev.removeAttribute('videl-state');
      }
      this.#nextByKey.set(key, el);
      el.setAttribute('videl-state', 'next');
    }

    /**
     * Synchronously remove `videl-state` from every child that has it.
     * Called automatically when the host's own `videl-state` is removed.
     */
    deactivateAll(): void {
      for (const child of Array.from(this.children)) {
        if (child.hasAttribute('videl-state')) {
          child.removeAttribute('videl-state');
        }
      }
      this.#activeByKey.clear();
      this.#nextByKey.clear();
    }
  }

  return PickN;
}
