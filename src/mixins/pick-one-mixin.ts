/**
 * PickOneMixin — manages `videl-state` lifecycle for elements that activate
 * exactly one child at a time.
 *
 * Guarantees:
 *  - At most one child holds `videl-state="active"` at any time.
 *  - At most one child holds `videl-state="next"` at any time.
 *  - When the host's own `videl-state` attribute is removed, all children are
 *    synchronously deactivated (cascade).
 *
 * Methods provided to subclasses:
 *  - `activateChild(el)` — set `videl-state="active"` on el
 *  - `preloadChild(el)`  — set `videl-state="next"` on el
 *  - `deactivateAll()`   — remove `videl-state` from every child that has it
 *
 * NOTE: this mixin no longer creates named shadow slots. Shadow DOM composition
 * is the responsibility of each element's own `render()` method. State is
 * communicated exclusively through the `videl-state` attribute (ADR-0002).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = HTMLElement> = new (...args: any[]) => T;

// Augmented base type that includes custom element lifecycle hooks so that
// `super.connectedCallback?.()` etc. type-check without `(super as any)` casts.
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
    #nextChild:   Element | null = null;

    static get observedAttributes(): string[] {
      // Walk up the static prototype chain from Base to find the first ancestor
      // that owns an `observedAttributes` getter, then invoke it with `this`
      // (the actual subclass) as receiver. When Base is LitElement this lets
      // the subclass finalize its full reactive-property attribute set rather
      // than getting the empty list of LitElement itself. For plain HTMLElement
      // bases no getter is found and we fall back to ['videl-state'].
      let proto: Function | null = Base;
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'observedAttributes');
        if (desc?.get) {
          const parentAttrs: string[] = desc.get.call(this) ?? [];
          return parentAttrs.includes('videl-state') ?
            parentAttrs :
            [...parentAttrs, 'videl-state'];
        }
        proto = Object.getPrototypeOf(proto);
      }
      return ['videl-state'];
    }

    connectedCallback(): void {
      super.connectedCallback?.();
    }

    attributeChangedCallback(name: string, old: string | null, value: string | null): void {
      super.attributeChangedCallback?.(name, old, value);
      // When own videl-state is removed, cascade deactivation synchronously.
      if (name === 'videl-state' && value === null) {
        this.deactivateAll();
      }
    }

    /**
     * Promote `el` to `videl-state="active"`. If another child already holds
     * `videl-state="active"`, its attribute is removed first.
     */
    activateChild(el: Element): void {
      if (this.#activeChild && this.#activeChild !== el) {
        this.#activeChild.removeAttribute('videl-state');
      }
      // If the element was previously the next child, clear that tracking.
      if (this.#nextChild === el) {
        this.#nextChild = null;
      }
      this.#activeChild = el;
      el.setAttribute('videl-state', 'active');
    }

    /**
     * Promote `el` to `videl-state="next"` (prefetch). If another child already
     * holds `videl-state="next"`, its attribute is removed first.
     */
    preloadChild(el: Element): void {
      if (this.#nextChild && this.#nextChild !== el) {
        this.#nextChild.removeAttribute('videl-state');
      }
      this.#nextChild = el;
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
      this.#activeChild = null;
      this.#nextChild   = null;
    }
  }

  return PickOne;
}
