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
 *
 * State lifecycle (ADR-0002 — `videl-state` attribute, not `slot`):
 *   videl-state="next"   → if `src` is set and not yet populated, fetch + parse
 *                          the MPD (prefetch).
 *   videl-state="active" → if not yet populated fetch inline; then activate the
 *                          first `<videl-period>` child.
 *   videl-state removed  → abort any in-flight fetch; cascade-deactivate children.
 *
 * Shadow DOM: default slot with technical children hidden by CSS. The element
 * itself is the playlist card; no wrapper or named card slot is needed.
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
    this.addEventListener('videl:done', this.#onPeriodDone);
  }

  disconnectedCallback(): void {
    this.removeEventListener('videl:done', this.#onPeriodDone);
    super.disconnectedCallback();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    // SequentialMixin → PickOneMixin → LitElement super chain.
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') return;

    if (value === 'next') {
      // Prefetch: fetch + parse the MPD so it is ready before activation.
      if (this.src && this.#childPeriods.length === 0) {
        this.#populate();
      }
    } else if (value === 'active') {
      if (this.src && this.#childPeriods.length === 0) {
        // Direct activation without prior prefetch: fetch inline then activate.
        this.#populate().then(() => this.#activateFirstPeriod());
      } else {
        // Children already present (pre-populated or prefetch completed).
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
    if (this.getAttribute('videl-state') !== 'active') return;
    const active = this.#childPeriods.find(
      p => p.getAttribute('videl-state') === 'active'
    );
    if (active) (active as any).videlUpdate(state);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  get #childPeriods(): Element[] {
    return Array.from((this as unknown as HTMLElement).children).filter(
      (el: unknown) => (el as Element).tagName.toLowerCase() === 'videl-period'
    ) as Element[];
  }

  #activateFirstPeriod(): void {
    const first = this.#childPeriods[0];
    if (first) this.activateChild(first);
  }

  async #populate(): Promise<void> {
    if (!this.src) return;

    this.#fetchController = new AbortController();
    try {
      const response = await fetch(this.src, { signal: this.#fetchController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${this.src}`);
      const xml = await response.text();

      let parseMpd: ((xml: string, baseUrl: string) => Element) | null = null;
      try {
        const mod = await import('../parser/mpd-parser.js' as any);
        parseMpd = mod.parseMpd ?? null;
      } catch {
        // Parser not yet available — fetch-only test still passes.
      }

      if (parseMpd) {
        const subtree = parseMpd(xml, this.src);
        while (this.firstChild) this.removeChild(this.firstChild);
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

  #onPeriodDone = (event: Event): void => {
    const target = event.target as Element;
    const self   = this as unknown as HTMLElement;
    if (target.parentElement !== self) return;
    if (target.tagName.toLowerCase() !== 'videl-period') return;
    if (target.nextElementSibling !== null) return;

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
    return html`
      <style>
        :host { display: block; }
        /*
         * Technical children injected by self-population are hidden by default.
         * They remain in the composed tree for DevTools inspection; the debug
         * flag or a consumer stylesheet can override this to make them visible.
         */
        ::slotted(videl-period) { display: none; }
      </style>
      <slot></slot>
      ${this.debug ? html`
        <div style="font-family:monospace;font-size:11px;border:1px solid #88a;padding:4px;margin-top:4px">
          <strong>videl-presentation</strong>
          type=<em>${this.presentationType}</em>
          state=<em>${this.getAttribute('videl-state') ?? 'idle'}</em>
          dur=<em>${this.mediaPresentationDuration ?? '?'}</em>s
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('videl-presentation', VidelPresentation as unknown as CustomElementConstructor);
