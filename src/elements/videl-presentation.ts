import { LitElement, html, nothing } from 'lit';
import { SequentialMixin } from '../mixins/sequential-mixin';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import type { PlayerState } from '../player-state';

/**
 * `<videl-presentation>` — the MPD root element.
 *
 * Holds top-level manifest attributes and advances sequentially through its
 * `<videl-period>` children via `SequentialMixin`. When all periods have
 * completed it fires `videl:done` with `{ src }` so `<videl-player>` can
 * advance to the next presentation in a playlist.
 *
 * Mixin stack: `SequentialMixin(PickOneMixin(LitElement))`.
 * Completion event listened by SequentialMixin: `'videl:done'`, filtered to
 * direct `<videl-period>` children (`event.target.parentElement === this`).
 *
 * Slot lifecycle:
 *   next   → if `src` is set and not yet populated, fetch + parse the MPD
 *             (requires DEL-007 parser; hook is present, full round-trip deferred).
 *   active → if not yet populated, fetch + parse inline; then activate the
 *             first `<videl-period>` child.
 *   null   → abort any in-flight fetch; cascade-deactivate children.
 */
export class VidelPresentation extends SequentialMixin(PickOneMixin(LitElement) as any) {
  static properties = {
    src:                       { type: String },
    mediaPresentationDuration: { type: Number,  attribute: 'media-presentation-duration' },
    minBufferTime:             { type: Number,  attribute: 'min-buffer-time' },
    presentationType:          { type: String,  attribute: 'type' },
    slot:                      { type: String,  reflect: true },
    debug:                     { type: Boolean },
  };

  src                       = '';
  mediaPresentationDuration: number | null = null;
  minBufferTime:             number | null = null;
  presentationType:          'static' | 'dynamic' = 'static';
  slot: string | undefined  = undefined;
  debug                     = false;

  #fetchController: AbortController | null = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback();
    // Additional listener alongside SequentialMixin's own 'videl:done' listener:
    // detect when the LAST period fires videl:done and escalate as the
    // presentation's own completion event with { src }.
    this.addEventListener('videl:done', this.#onPeriodDone);
  }

  disconnectedCallback(): void {
    this.removeEventListener('videl:done', this.#onPeriodDone);
    super.disconnectedCallback();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    // SequentialMixin → PickOneMixin → LitElement super chain.
    super.attributeChangedCallback(name, old, value);

    if (name !== 'slot') return;

    if (value === 'next') {
      // Prefetch: fetch + parse the MPD for this presentation so it is ready
      // before it becomes active. Only fetch if children not already present.
      if (this.src && this.#childPeriods.length === 0) {
        this.#populate();
      }
    } else if (value === 'active') {
      if (this.src && this.#childPeriods.length === 0) {
        // Direct activation without prior prefetch: fetch + parse inline, then
        // activate the first period.
        this.#populate().then(() => this.#activateFirstPeriod());
      } else {
        // Children already present (parser pre-populated or prefetch completed).
        this.#activateFirstPeriod();
      }
    } else if (value === null) {
      this.#fetchController?.abort();
      this.#fetchController = null;
    }
  }

  // ── Pump method ───────────────────────────────────────────────────────────

  /** Forward the pump tick to the currently active `<videl-period>`. */
  videlUpdate(state: PlayerState): void {
    if (this.getAttribute('slot') !== 'active') return;
    const active = this.#childPeriods.find(p => p.getAttribute('slot') === 'active');
    if (active) (active as any).videlUpdate(state);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  get #childPeriods(): Element[] {
    // Cast needed: SequentialMixin(…as any) loses HTMLElement context for `this`.
    return Array.from((this as unknown as HTMLElement).children).filter(
      (el: unknown) => (el as Element).tagName.toLowerCase() === 'videl-period'
    ) as Element[];
  }

  #activateFirstPeriod(): void {
    const first = this.#childPeriods[0];
    if (first) this.activateChild(first);
  }

  /**
   * Fetch + parse the MPD at `this.src` and populate child elements.
   * Full implementation requires the DEL-007 parser; this hook is present so
   * the fetch wiring is testable now and the parser can be dropped in later.
   */
  async #populate(): Promise<void> {
    if (!this.src) return;

    this.#fetchController = new AbortController();
    try {
      const response = await fetch(this.src, { signal: this.#fetchController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${this.src}`);
      const xml = await response.text();

      // Dynamic import so the parser can be swapped in when DEL-007 is ready.
      // Falls back gracefully if the parser module does not exist yet.
      let parseMpd: ((xml: string, baseUrl: string) => Element) | null = null;
      try {
        const mod = await import('../parser/mpd-parser.js' as any);
        parseMpd = mod.parseMpd ?? null;
      } catch {
        // Parser not yet available — fetch-only test still passes.
      }

      if (parseMpd) {
        const subtree = parseMpd(xml, this.src);
        // Replace children with parsed subtree's children.
        while (this.firstChild) this.removeChild(this.firstChild);
        // parseMpd returns a <videl-presentation> whose children we adopt.
        while (subtree.firstChild) this.appendChild(subtree.firstChild);
      }
    } catch (err: unknown) {
      if ((err as any)?.name === 'AbortError') return;
      this.dispatchEvent(
        new CustomEvent('videl:segment:error', {
          bubbles:  true,
          composed: true,
          detail:   { error: err instanceof Error ? err : new Error(String(err)) },
        })
      );
    } finally {
      this.#fetchController = null;
    }
  }

  /**
   * Fired on every `videl:done` that bubbles to this element.
   * Filters to direct `<videl-period>` children. If the completing period is
   * the last one (no next DOM sibling), fires the presentation's own
   * `videl:done` with `{ src }` so `<videl-player>` advances the playlist.
   *
   * Note: SequentialMixin already handles *advancement* to the next period.
   * This listener handles the *termination* case where no next period exists.
   */
  #onPeriodDone = (event: Event): void => {
    const target = event.target as Element;
    // Cast needed: SequentialMixin(…as any) means TypeScript doesn't know
    // `this` is an HTMLElement, so the comparison would otherwise be flagged
    // as having no overlap with HTMLElement | null.
    const self = this as unknown as HTMLElement;
    // Only act on direct <videl-period> children.
    if (target.parentElement !== self) return;
    if (target.tagName.toLowerCase() !== 'videl-period') return;

    // If there is a next sibling, SequentialMixin has already activated it —
    // this is not the last period.
    if (target.nextElementSibling !== null) return;

    // Last period completed — signal presentation done.
    self.dispatchEvent(
      new CustomEvent('videl:done', {
        bubbles:  true,
        composed: true,
        detail:   { src: (this as any).src },
      })
    );
  };

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    if (!this.debug) return nothing;
    return html`
      <style>
        :host { display: block; font-family: monospace; font-size: 11px;
                border: 1px solid #88a; padding: 4px; margin: 2px; }
      </style>
      <strong>videl-presentation</strong>
      type=<em>${this.presentationType}</em>
      slot=<em>${this.slot || 'unslotted'}</em>
      dur=<em>${this.mediaPresentationDuration ?? '?'}</em>s
      <slot name="active"></slot>
      <slot name="next"></slot>
    `;
  }
}

// Cast needed: the as-any mixin chain makes VidelPresentation's constructor
// signature opaque to the CustomElementConstructor constraint.
customElements.define('videl-presentation', VidelPresentation as unknown as CustomElementConstructor);
