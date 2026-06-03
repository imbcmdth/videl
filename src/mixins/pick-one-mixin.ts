/**
 * PickOneMixin — manages slot lifecycle for elements that activate exactly one
 * child at a time.
 *
 * Guarantees:
 *  - At most one child holds `slot=active` at any time.
 *  - At most one child holds `slot=next` at any time.
 *  - When the host's own `slot` attribute is removed, all slotted children are
 *    synchronously deactivated (cascade).
 *
 * Methods provided to subclasses:
 *  - `activateChild(el)` — promote el to `slot=active`
 *  - `preloadChild(el)` — promote el to `slot=next`
 *  - `deactivateAll()` — strip `slot` from every slotted child
 *
 * Shadow slots created: `<slot name="active">` and `<slot name="next">`.
 */

export type Constructor<T = HTMLElement> = new (...args: any[]) => T;

// Augmented base type that includes custom element lifecycle hooks so that
// `super.connectedCallback?.()` etc. type-check without `(super as any)` casts
// (which esbuild cannot lower).
type CEBase = Constructor<
  HTMLElement & {
    connectedCallback?(): void;
    disconnectedCallback?(): void;
    attributeChangedCallback?(name: string, old: string | null, value: string | null): void;
  }
>;

export function PickOneMixin<TBase extends CEBase>(Base: TBase) {
  class PickOne extends Base {
    #activeChild: Element | null = null;
    #nextChild: Element | null = null;

    static get observedAttributes(): string[] {
      // Walk up the static prototype chain from Base to find the first ancestor
      // that owns an `observedAttributes` getter, then invoke it with `this`
      // (the actual subclass) as receiver. When Base is LitElement this lets
      // the subclass finalize its full reactive-property attribute set rather
      // than getting the empty list of LitElement itself. For plain HTMLElement
      // bases no getter is found and we fall back to ['slot'].
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
      this.#ensureSlot('active');
      this.#ensureSlot('next');
    }

    attributeChangedCallback(name: string, old: string | null, value: string | null): void {
      super.attributeChangedCallback?.(name, old, value);
      // When own slot is removed, cascade deactivation synchronously.
      if (name === 'slot' && value === null) {
        this.deactivateAll();
      }
    }

    /**
     * Promote `el` to `slot=active`. If another child already holds
     * `slot=active`, its slot attribute is removed first.
     */
    activateChild(el: Element): void {
      if (this.#activeChild && this.#activeChild !== el) {
        this.#activeChild.removeAttribute('slot');
      }
      // If the element was previously the next child, clear that tracking.
      if (this.#nextChild === el) {
        this.#nextChild = null;
      }
      this.#activeChild = el;
      el.setAttribute('slot', 'active');
    }

    /**
     * Promote `el` to `slot=next` (prefetch). If another child already holds
     * `slot=next`, its slot attribute is removed first.
     */
    preloadChild(el: Element): void {
      if (this.#nextChild && this.#nextChild !== el) {
        this.#nextChild.removeAttribute('slot');
      }
      this.#nextChild = el;
      el.setAttribute('slot', 'next');
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
      this.#activeChild = null;
      this.#nextChild = null;
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

  return PickOne;
}
