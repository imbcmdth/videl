import { LitElement, html, nothing } from 'lit';
import { SequentialMixin } from '../mixins/sequential-mixin';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import { parseMpd } from '../parser/mpd-parser';
import type { PlayerState } from '../player-state';

/**
 * `<videl-presentation>` — the MPD root element and playlist card.
 *
 * Dual role:
 *  1. **Manifest owner** — self-populates from its own `src` MPD URL when
 *     `videl-state="next"` (prefetch) or `videl-state="active"` (inline).
 *     Only `<videl-period>` children are replaced on every populate; all
 *     other light-DOM children (user metadata, thumbnails, etc.) are preserved.
 *  2. **Playlist card** — the element itself is the visual unit; user content
 *     sits directly inside the element, no wrapper slot required.
 *
 * Mixin stack: `SequentialMixin(PickOneMixin(LitElement))`.
 *
 * State lifecycle (ADR-0002 — `videl-state` attribute):
 *   videl-state="next"   → self-populate from `src` (prefetch).
 *   videl-state="active" → self-populate if needed, then activate first period.
 *   videl-state removed  → abort in-flight fetch; cascade-deactivate periods.
 *
 * Shadow DOM: single default `<slot>` with `::slotted(videl-period)` hidden
 * by CSS so technical children are invisible but DevTools-inspectable.
 */
export class VidelPresentation extends SequentialMixin(PickOneMixin(LitElement) as any) {
  static properties = {
    src:                       { type: String },
    duration:                  { type: Number },
    mediaPresentationDuration: { type: Number,  attribute: 'media-presentation-duration' },
    minBufferTime:             { type: Number,  attribute: 'min-buffer-time' },
    presentationType:          { type: String,  attribute: 'type' },
    slot:                      { type: String,  reflect: true },
    debug:                     { type: Boolean },
  };

  src                        = '';
  /** Display duration (seconds) — shown before the manifest is fetched.
   *  Replaced by `mediaPresentationDuration` once the MPD is parsed. */
  duration:                  number | null = null;
  mediaPresentationDuration: number | null = null;
  minBufferTime:             number | null = null;
  presentationType:          'static' | 'dynamic' = 'static';
  slot: string | undefined   = undefined;
  debug                      = false;

  #fetchController: AbortController | null = null;
  #populated                               = false;
  #populatePromise: Promise<void> | null   = null;

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
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') return;

    if (value === 'next') {
      // Prefetch: populate so the manifest is ready before activation.
      if (this.src && !this.#populated) this.#ensurePopulated();
    } else if (value === 'active') {
      if (this.src && !this.#populated) {
        // No prior prefetch — populate inline, then activate.
        this.#ensurePopulated().then(() => {
          if (this.getAttribute('videl-state') === 'active') {
            this.#activateFirstPeriod();
          }
        });
      } else {
        this.#activateFirstPeriod();
      }
    } else if (value === null) {
      this.#fetchController?.abort();
      this.#fetchController = null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Forward the pump tick to the currently active `<videl-period>`. */
  videlUpdate(state: PlayerState): void {
    if (this.getAttribute('videl-state') !== 'active') return;
    const active = this.#childPeriods.find(
      p => p.getAttribute('videl-state') === 'active'
    );
    if (active) (active as any).videlUpdate(state);
  }

  /**
   * Explicitly trigger self-population. Idempotent — safe to call multiple
   * times; only the first call ever fetches. Called by `<videl-player>` before
   * MSE setup so SourceBuffer creation can see the full adaptation-set tree.
   */
  videlPopulate(): Promise<void> {
    return this.#ensurePopulated();
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

  #ensurePopulated(): Promise<void> {
    if (this.#populated) return Promise.resolve();
    if (this.#populatePromise) return this.#populatePromise;
    this.#populatePromise = this.#populate().finally(() => {
      this.#populatePromise = null;
    });
    return this.#populatePromise;
  }

  /**
   * Fetch the MPD at `src`, parse it, and inject `<videl-period>` children.
   *
   * Non-period children (user metadata: thumbnails, headings, etc.) are
   * preserved. Only existing `<videl-period>` elements are removed before
   * injection. Manifest-derived attributes (`media-presentation-duration`,
   * `min-buffer-time`, `type`) are stamped onto this element after parsing.
   */
  async #populate(): Promise<void> {
    if (!this.src) return;

    this.#fetchController = new AbortController();
    try {
      const response = await fetch(this.src, { signal: this.#fetchController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${this.src}`);
      const xml = await response.text();

      const self    = this as unknown as HTMLElement;
      const subtree = parseMpd(xml, this.src);

      // Remove existing period children — preserve all other light-DOM content.
      for (const child of [...self.children]) {
        if (child.tagName.toLowerCase() === 'videl-period') {
          self.removeChild(child);
        }
      }

      // Adopt parsed period children.
      for (const child of [...subtree.children]) {
        if (child.tagName.toLowerCase() === 'videl-period') {
          self.appendChild(child);
        }
      }

      // Stamp manifest attributes (may override developer-declared display values).
      const dur    = subtree.getAttribute('media-presentation-duration');
      const minBuf = subtree.getAttribute('min-buffer-time');
      const type   = subtree.getAttribute('type');
      if (dur)    self.setAttribute('media-presentation-duration', dur);
      if (minBuf) self.setAttribute('min-buffer-time', minBuf);
      if (type)   self.setAttribute('type', type);

      this.#populated = true;

    } catch (err: unknown) {
      if ((err as any)?.name === 'AbortError') return;
      (this as unknown as HTMLElement).dispatchEvent(
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
   * Detect when the last period completes and escalate as presentation done.
   * SequentialMixin handles *advancement* to the next period; this handles
   * the *termination* case (no next period sibling exists).
   */
  #onPeriodDone = (event: Event): void => {
    const target = event.target as Element;
    const self   = this as unknown as HTMLElement;
    if (target.parentElement !== self) return;
    if (target.tagName.toLowerCase() !== 'videl-period') return;
    // If a next period sibling exists, SequentialMixin already activated it.
    let nextPeriod = target.nextElementSibling;
    while (nextPeriod && nextPeriod.tagName.toLowerCase() !== 'videl-period') {
      nextPeriod = nextPeriod.nextElementSibling;
    }
    if (nextPeriod !== null) return;

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
          dur=<em>${this.mediaPresentationDuration ?? this.duration ?? '?'}</em>s
          populated=<em>${this.#populated}</em>
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('videl-presentation', VidelPresentation as unknown as CustomElementConstructor);
