import { LitElement, html, nothing, css, unsafeCSS } from 'lit';
import periodCss from '../styles/videl-period.css';
import { PickNMixin } from '../mixins/pick-n-mixin';
import type { PlayerState } from '../player-state';
import { VidelBeforeActivateEvent } from '../events';
import { VidelAdaptationSet } from './videl-adaptation-set';
import { VidelEventStream } from './videl-event-stream';

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
  static styles = css`${unsafeCSS(periodCss)}`;

  static properties = {
    periodId: { type: String,  attribute: 'dash-id' },
    start: { type: Number },
    duration: { type: Number },
    slot: { type: String,  reflect: true },
    /**
     * Which informational menu is currently revealed: `"audio"`, `"text"`,
     * or `"quality"`. Set by the parent `<videl-presentation>` control bar
     * (a child-attribute, same ownership model as `videl-state`). Absent =
     * no menu open. Purely a visual-composition concern — independent of
     * `videl-state` (ADR-0002).
     */
    menuOpen: { type: String, attribute: 'videl-menu-open' }
  };

  periodId = '';
  start    = 0;
  /** Absent (null) = open-ended period — `videl:done` will never fire. */
  duration: number | null = null;
  slot = '';
  menuOpen: string | null = null;

  /** Last currentWallTime seen by videlUpdate — needed by track-select handler. */
  #lastCurrentTime = 0;

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
    this.addEventListener('videl:track:select', this.#onTrackSelect as EventListener);
  }

  disconnectedCallback(): void {
    this.removeEventListener('videl:track:select', this.#onTrackSelect as EventListener);
    super.disconnectedCallback?.();
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

    if (name !== 'videl-state') {
      return;
    }

    if (value === 'active') {
      this.#onBecomeActive().catch(err => this.#onActivateError(err));
    } else if (value === 'next') {
      this.#preloadAll();
    } else if (value === null) {
      // Reset completion flag so re-activation works correctly.
      this.removeAttribute('videl-done');
      // Close any open menu — a deactivated period must not keep a popup open.
      if (this.hasAttribute('videl-menu-open')) {
        this.removeAttribute('videl-menu-open');
      }
      // Deactivate all event streams (PickNMixin handles adaptation sets).
      for (const es of this.#childEventStreams) {
        es.removeAttribute('videl-state');
      }
    }
  }

  /**
   * Async activation path: fires `videl:before-activate` before activating all
   * adaptation sets.
   */
  async #onBecomeActive(): Promise<void> {
    await this.#fireBeforeActivate();
    this.#activateAll();
  }

  /**
   * Fire the `videl:before-activate` event and wait for all `waitUntil` promises
   * to settle.
   */
  async #fireBeforeActivate(): Promise<void> {
    const event = new VidelBeforeActivateEvent(this as unknown as Element);
    this.dispatchEvent(event);
    await event.settled;
  }

  /**
   * Handle activation failure: revert the `videl-state` attribute and dispatch
   * a `videl:activate:error` event.
   */
  #onActivateError(err: unknown): void {
    this.removeAttribute('videl-state');
    this.dispatchEvent(new CustomEvent('videl:activate:error', {
      bubbles: true,
      composed: true,
      detail: {
        element: this,
        error: err instanceof Error ? err : new Error(String(err))
      }
    }));
  }

  // ── Pump method ───────────────────────────────────────────────────────────

  /**
   * Called by the parent presentation on each pump tick while active.
   *
   * 1. Forward the full PlayerState to every currently-active adaptation set.
   * 2. Fire `videl:done` exactly once, whichever comes first:
   *    - all media adaptation sets have buffered their last segment (primary), or
   *    - `currentTime >= start + duration` (fallback for stalled fetches).
   */
  videlUpdate(state: PlayerState): void {
    if (this.getAttribute('videl-state') !== 'active') {
      return;
    }

    this.#lastCurrentTime = state.currentWallTime;

    // Fan out to all active adaptation sets.
    for (const ads of this.#activeAdaptationSets) {
      ads.videlUpdate(state);
    }

    // Fan out to all active event streams (excluded from period-completion
    // logic — event streams never gate period advancement).
    for (const es of this.#childEventStreams) {
      if (es.getAttribute('videl-state') === 'active') {
        es.videlUpdate(state);
      }
    }

    // Period completion — fires videl:done on whichever trigger comes first:
    //
    // PRIMARY: all media (video + audio) adaptation sets have buffered their
    // last segment. Text tracks are excluded — the None ADS has no segments,
    // and real text tracks don't gate period advancement. This fires earlier
    // than the playhead reaching the boundary, giving the next period time to
    // start filling the shared SourceBuffers before they run dry.
    //
    // FALLBACK: currentWallTime reaches the declared end. This fires if the
    // primary trigger never arrives (e.g. a segment fetch stalls permanently),
    // ensuring the player always advances rather than stalling at a broken period.
    //
    // Only fires for periods with a known duration; live / open-ended periods
    // never complete via either path.
    if (!this.hasAttribute('videl-done') && this.duration !== null) {
      const mediaAdsSets = this.#activeAdaptationSets.filter(ads => ads.contentType === 'video' || ads.contentType === 'audio');
      const lastSegmentBuffered =
        mediaAdsSets.length > 0 &&
        mediaAdsSets.every(ads => ads.isFullyFetched);
      const playheadAtEnd = state.currentWallTime >= this.start + this.duration;

      if (lastSegmentBuffered || playheadAtEnd) {
        this.setAttribute('videl-done', '');
        this.dispatchEvent(new CustomEvent('videl:done', {
          bubbles: true,
          composed: true,
          detail: { periodId: this.periodId }
        }));
      }
    }
  }

  // ── Overridable selection hook ────────────────────────────────────────────

  /**
   * Given a list of `<videl-adaptation-set>` candidates sharing the same
   * `content-type`, return the one to activate. Default: first in DOM order.
   */
  selectAdaptationSet(_contentType: string, candidates: VidelAdaptationSet[]): VidelAdaptationSet | null {
    return candidates[0] ?? null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  get #childAdaptationSets(): VidelAdaptationSet[] {
    return Array.from(this.children).filter(el => el.tagName.toLowerCase() === 'videl-adaptation-set') as VidelAdaptationSet[];
  }

  /** All adaptation-set children that are currently active. */
  get #activeAdaptationSets(): VidelAdaptationSet[] {
    return this.#childAdaptationSets.filter(el => el.getAttribute('videl-state') === 'active');
  }

  /** All `<videl-event-stream>` direct children. */
  get #childEventStreams(): VidelEventStream[] {
    return Array.from(this.children).filter(el => el.tagName.toLowerCase() === 'videl-event-stream') as VidelEventStream[];
  }

  /** Group adaptation-set children by their `content-type` attribute. */
  #groupByContentType(): Map<string, VidelAdaptationSet[]> {
    const map = new Map<string, VidelAdaptationSet[]>();
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
   * For text, the first candidate is the "None" ADS injected by the parser —
   * activating it hides the TextTrack (subtitles off by default).
   * All event streams are activated unconditionally (no selection logic). */
  #activateAll(): void {
    for (const [contentType, candidates] of this.#groupByContentType()) {
      const chosen = this.selectAdaptationSet(contentType, candidates);
      if (chosen) {
        this.activateChild(chosen);
      }
    }
    for (const es of this.#childEventStreams) {
      es.setAttribute('videl-state', 'active');
    }
  }

  /** Preload the first adaptation set per content-type simultaneously.
   * All event streams are also preloaded so context is sent early. */
  #preloadAll(): void {
    for (const [contentType, candidates] of this.#groupByContentType()) {
      const chosen = this.selectAdaptationSet(contentType, candidates);
      if (chosen) {
        this.preloadChild(chosen);
      }
    }
    for (const es of this.#childEventStreams) {
      es.setAttribute('videl-state', 'next');
    }
  }

  // ── PickNMixin contract ───────────────────────────────────────────────────

  /** PickNMixin calls this to determine the per-key group for a child. */
  getSlotKey(child: Element): string {
    return child.getAttribute('content-type') ?? 'video';
  }

  /**
   * Handle a user-initiated track selection for audio or text adaptation sets.
   *
   * For audio: trims the shared SourceBuffer from currentTime forward so the
   * new language starts loading immediately rather than waiting for the buffer
   * to drain. PickNMixin deactivates the previously active ADS automatically.
   *
   * For text: trims the shared TextSourceBuffer (clears cues from currentTime
   * forward) then activates the selected ADS, which calls show() or hide() on
   * the TextTrack via its own attributeChangedCallback.
   */
  #onTrackSelect = (e: Event): void => {
    const newAds = (e as CustomEvent).detail?.ads as Element | undefined;
    if (!(newAds instanceof Element)) {
      return;
    }
    // Only respond to events from direct children of THIS period.
    if (newAds.parentElement !== (this as unknown as HTMLElement)) {
      return;
    }

    const ct = newAds.getAttribute('content-type');
    if (ct !== 'audio' && ct !== 'text') {
      return;
    }
    // Already active — no-op.
    if (newAds.getAttribute('videl-state') === 'active') {
      return;
    }

    // Trim the currently active ADS's source buffer from currentTime so the
    // new track starts from the playhead rather than the buffer's end.
    const currentActive = this.#childAdaptationSets.find(a => a.getAttribute('content-type') === ct &&
           a.getAttribute('videl-state') === 'active');
    const sb = currentActive?.sourceBuffer;
    if (sb) {
      sb.remove(this.#lastCurrentTime, Infinity).catch(() => {});
    }

    // Activate the new ADS. PickNMixin deactivates the previously active one.
    // For text: VidelAdaptationSet.attributeChangedCallback calls show()/hide()
    // on the TextSourceBuffer based on the videl-text-none attribute.
    this.activateChild(newAds);
  };

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    // Keep flex-grow in sync with duration on every render (catches any late
    // attribute changes and works around useDefineForClassFields shadowing).
    //
    // Exception: for live (dynamic) presentations, flex-grow is owned by
    // videl-presentation's #updateLivePeriodWindows() which runs every pump
    // tick and clamps it to the DVR window intersection. Calling #applyFlexGrow()
    // here would overwrite that windowed value with the raw (potentially
    // ever-growing) period duration each time Lit re-renders.
    if (this.parentElement?.getAttribute('type') !== 'dynamic') {
      this.#applyFlexGrow();
    }

    const titles: Record<string, string> = {
      audio: 'Audio',
      text: 'Subtitles',
      quality: 'Quality'
    };
    const title = this.menuOpen ? (titles[this.menuOpen] ?? this.menuOpen) : '';

    return html`
      <div class="menu">
        ${this.menuOpen ? html`<div class="menu-title">${title}</div>` : nothing}
        <slot></slot>
      </div>
    `;
  }
}

customElements.define('videl-period', VidelPeriod);
