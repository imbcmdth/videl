/**
 * PickNMixin — manages slot lifecycle for elements that activate multiple
 * children simultaneously, grouped by a key (e.g. content type: video/audio).
 *
 * Guarantees:
 *  - At most one child per key holds `slot=${key}-active` at any time.
 *  - At most one child per key holds `slot=${key}-next` at any time.
 *  - Children with different keys can hold `slot=*-active` simultaneously.
 *  - Shadow slots are created lazily on first use of each key.
 *  - When the host's own `slot` attribute is removed, all slotted children are
 *    synchronously deactivated (cascade).
 *
 * Subclasses must override `getSlotKey(child)` to map a child element to its
 * grouping key.
 *
 * Methods provided to subclasses:
 *  - `activateChild(el)` — promote el to `slot=${key}-active`
 *  - `preloadChild(el)` — promote el to `slot=${key}-next`
 *  - `deactivateAll()` — strip `slot` from every slotted child
 */

import type { Constructor } from './pick-one-mixin';
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
    #nextByKey: Map<string, Element> = new Map();

    static get observedAttributes(): string[] {
      // Same fix as PickOneMixin: walk up to find the getter, call with `this`.
      let proto: any = Base;
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'observedAttributes');
        if (desc?.get) {
          const parentAttrs: string[] = desc.get.call(this) ?? [];
          return parentAttrs.includes('slot') ? parentAttrs : [...parentAttrs, 'slot'];
        }
        proto = Object.getPrototypeOf(proto);
      }
      return ['slot'];
    }

    connectedCallback(): void {
      super.connectedCallback?.();
      if (!this.shadowRoot) {
        this.attachShadow({ mode: 'open' });
      }
    }

    attributeChangedCallback(name: string, old: string | null, value: string | null): void {
      super.attributeChangedCallback?.(name, old, value);
      if (name === 'slot' && value === null) {
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
     * Promote `el` to `slot=${key}-active`. If another child with the same key
     * already holds that slot, it is removed first.
     */
    activateChild(el: Element): void {
      const key = this.getSlotKey(el);
      const slotName = `${key}-active`;

      const prev = this.#activeByKey.get(key);
      if (prev && prev !== el) {
        prev.removeAttribute('slot');
      }
      // If this element was the next child for this key, clear that tracking.
      if (this.#nextByKey.get(key) === el) {
        this.#nextByKey.delete(key);
      }

      this.#activeByKey.set(key, el);
      this.#ensureSlot(slotName);
      el.setAttribute('slot', slotName);
    }

    /**
     * Promote `el` to `slot=${key}-next`. If another child with the same key
     * already holds that slot, it is removed first.
     */
    preloadChild(el: Element): void {
      const key = this.getSlotKey(el);
      const slotName = `${key}-next`;

      const prev = this.#nextByKey.get(key);
      if (prev && prev !== el) {
        prev.removeAttribute('slot');
      }

      this.#nextByKey.set(key, el);
      this.#ensureSlot(slotName);
      el.setAttribute('slot', slotName);
    }

    /**
     * Synchronously remove `slot` from every child that has one.
     * Called automatically when the host's own slot is removed.
     */
    deactivateAll(): void {
      for (const child of Array.from(this.children)) {
        if (child.hasAttribute('slot')) {
          child.removeAttribute('slot');
        }
      }
      this.#activeByKey.clear();
      this.#nextByKey.clear();
    }

    #ensureSlot(name: string): void {
      if (!this.shadowRoot) return;
      if (!this.shadowRoot.querySelector(`slot[name="${name}"]`)) {
        const slot = document.createElement('slot');
        slot.name = name;
        this.shadowRoot.appendChild(slot);
      }
    }
  }

  return PickN;
}
