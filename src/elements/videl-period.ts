import { LitElement, html, nothing } from 'lit';
import { PickNMixin } from '../mixins/pick-n-mixin';
import type { PlayerState } from '../player-state';

/**
 * `<videl-period>` — owns a set of `<videl-adaptation-set>` children and
 * activates one per unique `content-type` simultaneously (video + audio +
 * optional text).
 *
 * Mixin: `PickNMixin(LitElement)`.
 * Key: the `content-type` attribute of each `<videl-adaptation-set>` child.
 *
 * State lifecycle (ADR-0002 — `videl-state` attribute, not `slot`):
 *   videl-state="active" → activate one adaptation-set per content-type.
 *   videl-state="next"   → preload one adaptation-set per content-type.
 *   videl-state removed  → cascade-deactivate all children (PickNMixin).
 *
 * Period-end detection: when `currentTime >= start + duration` on a pump tick,
 * `videl:done` fires exactly once with `{ periodId }`. Does NOT fire when the
 * `duration` attribute is absent (open-ended / live period).
 */
export class VidelPeriod extends PickNMixin(LitElement) {
  static properties = {
    periodId: { type: String,  attribute: 'period-id' },
    start:    { type: Number },
    duration: { type: Number },
    slot:     { type: String,  reflect: true },
    debug:    { type: Boolean },
    /**
     * Which informational menu is currently revealed: `"audio"`, `"text"`,
     * or `"quality"`. Set by the parent `<videl-presentation>` control bar
     * (a child-attribute, same ownership model as `videl-state`). Absent =
     * no menu open. Purely a visual-composition concern — independent of
     * `videl-state` (ADR-0002).
     */
    menuOpen: { type: String, attribute: 'menu-open' },
  };

  periodId = '';
  start    = 0;
  /** Absent (null) = open-ended period — `videl:done` will never fire. */
  duration: number | null = null;
  slot = '';
  debug    = false;
  menuOpen: string | null = null;

  #doneEmitted = false;

  // ── Custom element lifecycle ──────────────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback();
    // Self-assign to the presentation's named seekbar slot for visual
    // composition (ADR-0002: this is layout, not playback state).
    // We read the attribute directly to avoid useDefineForClassFields
    // shadowing the reactive accessor before the first Lit render.
    if (!this.getAttribute('slot') &&
        this.parentElement?.tagName.toLowerCase() === 'videl-presentation') {
      this.setAttribute('slot', 'seek');
      // Also apply flex-grow immediately (before first Lit render).
      this.#applyFlexGrow();
    }
  }

  /** Set flex-grow on the host element to match the period duration. */
  #applyFlexGrow(): void {
    const dur = parseFloat(this.getAttribute('duration') ?? '') || 1;
    (this as unknown as HTMLElement).style.flexGrow = String(dur);
    (this as unknown as HTMLElement).style.minWidth = '2px';
  }

  // ── State lifecycle ───────────────────────────────────────────────────────

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    // PickNMixin + LitElement super chain (cascade deactivation when videl-state removed).
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') return;

    if (value === 'active') {
      this.#activateAll();
    } else if (value === 'next') {
      this.#preloadAll();
    } else if (value === null) {
      // Reset completion flag so re-activation works correctly.
      this.#doneEmitted = false;
      // Close any open menu — a deactivated period must not keep a popup open.
      if (this.hasAttribute('menu-open')) this.removeAttribute('menu-open');
    }
  }

  // ── Pump method ───────────────────────────────────────────────────────────

  /**
   * Called by the parent presentation on each pump tick while active.
   *
   * 1. Forward the full PlayerState to every currently-active adaptation set.
   * 2. Check for period end: if `currentTime >= start + duration`, fire
   *    `videl:done` exactly once.
   */
  videlUpdate(state: PlayerState): void {
    if (this.getAttribute('videl-state') !== 'active') return;

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

  /** All adaptation-set children that are currently active. */
  get #activeAdaptationSets(): Element[] {
    return this.#childAdaptationSets.filter(
      el => el.getAttribute('videl-state') === 'active'
    );
  }

  /** Group adaptation-set children by their `content-type` attribute. */
  #groupByContentType(): Map<string, Element[]> {
    const map = new Map<string, Element[]>();
    for (const child of this.#childAdaptationSets) {
      const key    = child.getAttribute('content-type') ?? 'video';
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(child);
      } else {
        map.set(key, [child]);
      }
    }
    return map;
  }

  /** Activate the first adaptation set per content-type simultaneously.
   *
   * Text tracks are intentionally excluded: MSE has no mechanism to render
   * text from an MP4 container — that requires separate in-band parsing and
   * injection into the HTMLVideoElement's native TextTrack API, which is
   * beyond the current scope. */
  #activateAll(): void {
    for (const [contentType, candidates] of this.#groupByContentType()) {
      if (contentType === 'text') continue;
      const chosen = this.selectAdaptationSet(contentType, candidates);
      if (chosen) this.activateChild(chosen);
    }
  }

  /** Preload the first adaptation set per content-type simultaneously.
   * Text tracks are excluded for the same reason as #activateAll. */
  #preloadAll(): void {
    for (const [contentType, candidates] of this.#groupByContentType()) {
      if (contentType === 'text') continue;
      const chosen = this.selectAdaptationSet(contentType, candidates);
      if (chosen) this.preloadChild(chosen);
    }
  }

  // ── PickNMixin contract ───────────────────────────────────────────────────

  /** PickNMixin calls this to determine the per-key group for a child. */
  getSlotKey(child: Element): string {
    return child.getAttribute('content-type') ?? 'video';
  }

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    // Keep flex-grow in sync with duration on every render (catches any late
    // attribute changes and works around useDefineForClassFields shadowing).
    this.#applyFlexGrow();

    const titles: Record<string, string> = {
      audio:   'Audio',
      text:    'Subtitles',
      quality: 'Quality',
    };
    const title = this.menuOpen ? (titles[this.menuOpen] ?? this.menuOpen) : '';

    return html`
      <style>
        /*
         * The period renders as a proportional seekbar segment.
         * flex-grow is set directly on the host element (style.flexGrow) so
         * it can carry a dynamic numeric value — CSS cannot do this from
         * ::slotted() rules on the containing shadow.
         *
         * NOTE: no position:relative here. Keeping the host position:static
         * means the menu popup's position:absolute walks up to .controls
         * (the nearest positioned ancestor in the layout tree), so the popup
         * appears above the whole control bar regardless of where the segment
         * is in the seekbar.
         */
        :host {
          display: block;
          height: 100%;
          background: rgba(255, 255, 255, 0.2);
          transition: background 0.15s;
        }
        :host([videl-state="active"]) { background: rgba(255, 255, 255, 0.9); }
        :host([videl-state="next"])   { background: rgba(255, 255, 255, 0.4); }

        /* Adaptation sets are hidden by default. */
        ::slotted(videl-adaptation-set) { display: none !important; }

        /* Reveal matching group when menu is open. */
        :host([menu-open="audio"])
          ::slotted(videl-adaptation-set[content-type="audio"])          { display: block !important; }
        :host([menu-open="text"])
          ::slotted(videl-adaptation-set[content-type="text"])           { display: block !important; }
        :host([menu-open="quality"])
          ::slotted(videl-adaptation-set[content-type="video"][videl-state="active"]) { display: block !important; }

        /* ── Menu popup ───────────────────────────────────────────── */
        /*
         * position:absolute with no positioned ancestor on the period host
         * means .controls (position:absolute on the presentation shadow) is
         * the containing block. bottom:calc(100% + 4px) puts the popup just
         * above the top edge of the controls bar; right:8px aligns it to the
         * player's right edge.
         */
        .menu { display: none; }
        :host([menu-open]) .menu {
          display: block;
          position: absolute;
          bottom: calc(100% + 4px);
          right: 8px;
          min-width: 160px;
          max-width: 260px;
          max-height: 220px;
          overflow-y: auto;
          background: rgba(16, 16, 16, 0.96);
          border: 1px solid rgba(255, 255, 255, 0.18);
          padding: 4px;
          z-index: 4;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
        }
        .menu-title {
          color: #777;
          font-family: ui-monospace, monospace;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          padding: 6px 8px 4px;
          user-select: none;
        }
      </style>

      <div class="menu">
        ${this.menuOpen ? html`<div class="menu-title">${title}</div>` : nothing}
        <slot></slot>
      </div>

      ${this.debug ? html`
        <div style="font-family:monospace;font-size:11px;border:1px solid #a88;padding:4px;background:rgba(0,0,0,0.7);color:#fff;position:absolute;top:100%;left:0;z-index:10;white-space:nowrap">
          <strong>videl-period</strong>
          id=<em>${this.periodId}</em>
          state=<em>${this.getAttribute('videl-state') ?? 'idle'}</em>
          t=<em>${this.start}</em>+<em>${this.duration ?? '∞'}</em>s
          menu=<em>${this.menuOpen ?? 'none'}</em>
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('videl-period', VidelPeriod);
