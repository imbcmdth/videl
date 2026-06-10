// ── Shared DOM + mixin utilities ──────────────────────────────────────────────

/**
 * Return all **direct** children of `parent` whose tag name matches `tagName`
 * (case-insensitive), cast to `T`.
 *
 * Equivalent to the repeated inline pattern:
 * ```ts
 * Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'videl-xxx') as T[]
 * ```
 */
export function childrenByTag<T extends Element>(parent: ParentNode, tagName: string): T[] {
  return Array.from(parent.children).filter(el => el.tagName.toLowerCase() === tagName) as T[];
}

/**
 * Walk the **static** prototype chain of `Base` looking for an
 * `observedAttributes` getter.  When found, merge its result with `own` and
 * return the de-duplicated union.  Falls back to `own` if no getter is found.
 *
 * Used by `PickOneMixin` and `PickNMixin` so that both share the exact same
 * logic for inheriting a LitElement base's reactive-property attribute list
 * without duplicating the traversal.
 *
 * @param Base    - The mixin's `TBase` constructor parameter.
 * @param thisArg - The `this` receiver for the getter call (the concrete subclass).
 * @param own     - Attributes owned by the mixin itself (e.g. `['videl-state']`).
 */
export function mergeObservedAttributes(
  Base: Function,
  thisArg: unknown,
  own: string[]
): string[] {
  let proto: Function | null = Base;
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'observedAttributes');
    if (desc?.get) {
      const parentAttrs: string[] = desc.get.call(thisArg) ?? [];
      // Keep parent order; append any own attrs not already present.
      const extra = own.filter(a => !parentAttrs.includes(a));
      return extra.length ? [...parentAttrs, ...extra] : parentAttrs;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return own;
}
