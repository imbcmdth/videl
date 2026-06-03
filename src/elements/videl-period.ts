import { LitElement, html, nothing } from 'lit';
import { PickNMixin } from '../mixins/pick-n-mixin';
import type { PlayerState } from '../player-state';

/**
 * `<videl-period>` — owns a set of `<videl-adaptation-set>` children and
 * activates one per unique `content-type` simultaneously (video + audio +
 * optional text).
 *
 * Mixin: `PickNMixin(LitElement)`.
 * Slot key: the `content-type` attribute of each `<videl-adaptation-set>` child.
 *
 * Slot lifecycle:
 *   next   → preload one adaptation-set per content-type (slot=`${type}-next`).
 *   active → activate one adaptation-set per content-type simultaneously.
 *   null   → cascade-deactivate all children (PickNMixin).
 *
 * Period-end detection: when `currentTime >= start + duration` on a pump tick,
 * `videl:done` fires exactly once with `{ periodId }`. Does NOT fire when the
 * `duration` attribute is absent (open-ended / live period).
 *
 * The `selectAdaptationSet(contentType, candidates)` method is intentionally
 * public and overridable — replace the element with a subclass or custom
 * element to implement custom adaptation-set selection logic.
 */
export class VidelPeriod extends PickNMixin(LitElement) {
  static properties = {
    periodId: { type: String,  attribute: 'period-id' },
    start:    { type: Number },
    duration: { type: Number },
    slot:     { type: String,  reflect: true },
    debug:    { type: Boolean },
  };

  periodId = '';
  start    = 0;
  /** Absent (null) = open-ended period — `videl:done` will never fire. */
  duration: number | null = null;
  slot: string | undefined = undefined;
  debug    = false;

  #doneEmitted = false;

  // ── Slot lifecycle ────────────────────────────────────────────────────────

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    // PickNMixin + LitElement super chain (cascade deactivation when slot is removed).
    super.attributeChangedCallback(name, old, value);

    if (name !== 'slot') return;

    if (value === 'active') {
      this.#activateAll();
    } else if (value === 'next') {
      this.#preloadAll();
    } else if (value === null) {
      // Reset completion flag so re-activation works correctly.
      this.#doneEmitted = false;
    }
  }

  // ── Pump method ───────────────────────────────────────────────────────────

  /**
   * Called by the parent presentation on each pump tick while `slot=active`.
   *
   * 1. Forward the full PlayerState to every currently-active adaptation set.
   * 2. Check for period end: if `currentTime >= start + duration`, fire
   *    `videl:done` exactly once.
   */
  /** Named `videlUpdate` to avoid colliding with LitElement's `update()` lifecycle. */
  videlUpdate(state: PlayerState): void {
    if (this.getAttribute('slot') !== 'active') return;

    // Fan out to all active adaptation sets.
    for (const ads of this.#activeAdaptationSets) {
      (ads as any).videlUpdate(state);
    }

    // Period-end check — only when duration is explicitly set.
    if (!this.#doneEmitted && this.duration !== null) {
      if (state.currentTime >= this.start + this.duration) {
        this.#doneEmitted = true;
        this.dispatchEvent(
          new CustomEvent('videl:done', {
            bubbles:  true,
            composed: true,
            detail:   { periodId: this.periodId },
          })
        );
      }
    }
  }

  // ── Overridable selection hook ────────────────────────────────────────────

  /**
   * Given a list of `<videl-adaptation-set>` candidates sharing the same
   * `content-type`, return the one to activate. Default: first in DOM order.
   *
   * Override (via subclass or custom element swap) for custom selection logic.
   */
  selectAdaptationSet(_contentType: string, candidates: Element[]): Element | null {
    return candidates[0] ?? null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  get #childAdaptationSets(): Element[] {
    return Array.from(this.children).filter(
      el => el.tagName.toLowerCase() === 'videl-adaptation-set'
    );
  }

  /** All adaptation-set children whose slot ends with `-active`. */
  get #activeAdaptationSets(): Element[] {
    return this.#childAdaptationSets.filter(el =>
      el.getAttribute('slot')?.endsWith('-active') === true
    );
  }

  /** Group adaptation-set children by their `content-type` attribute. */
  #groupByContentType(): Map<string, Element[]> {
    const map = new Map<string, Element[]>();
    for (const child of this.#childAdaptationSets) {
      const key = child.getAttribute('content-type') ?? 'video';
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(child);
      } else {
        map.set(key, [child]);
      }
    }
    return map;
  }

  /** Activate the first adaptation set per content-type simultaneously. */
  #activateAll(): void {
    for (const [contentType, candidates] of this.#groupByContentType()) {
      const chosen = this.selectAdaptationSet(contentType, candidates);
      if (chosen) this.activateChild(chosen); // PickNMixin keys by content-type
    }
  }

  /** Preload the first adaptation set per content-type simultaneously. */
  #preloadAll(): void {
    for (const [contentType, candidates] of this.#groupByContentType()) {
      const chosen = this.selectAdaptationSet(contentType, candidates);
      if (chosen) this.preloadChild(chosen);
    }
  }

  // ── PickNMixin contract ───────────────────────────────────────────────────

  /** PickNMixin calls this to determine the slot-name group for a child. */
  getSlotKey(child: Element): string {
    return child.getAttribute('content-type') ?? 'video';
  }

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    if (!this.debug) return nothing;
    return html`
      <style>
        :host { display: block; font-family: monospace; font-size: 11px;
                border: 1px solid #a88; padding: 4px; margin: 2px; }
      </style>
      <strong>videl-period</strong>
      id=<em>${this.periodId}</em>
      slot=<em>${this.slot ?? 'unslotted'}</em>
      t=<em>${this.start}</em>+<em>${this.duration ?? '∞'}</em>s
    `;
  }
}

customElements.define('videl-period', VidelPeriod);
