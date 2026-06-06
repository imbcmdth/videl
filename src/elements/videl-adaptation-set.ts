import { LitElement, html, nothing } from 'lit';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import type { PlayerState } from '../player-state';
import type { ISourceBuffer } from '../text-track/i-source-buffer';
import { trace } from '../trace';

/**
 * `<videl-adaptation-set>` — owns a set of `<videl-representation>` children
 * for one content type (video | audio | text).
 *
 * Responsibilities:
 *  - ABR: on each `videlUpdate()` tick, select the highest-bandwidth
 *    representation whose bitrate ≤ `bandwidth × abrSafetyFactor / playbackRate`.
 *  - SourceBuffer distribution: forward the `ManagedSourceBuffer` received from
 *    `<videl-player>` to all child representations before activation.
 *  - Codec change: if an ABR switch requires a different codec, attempt
 *    `sourceBuffer.changeType()`; fire `videl:mse:incompatible` if that fails.
 *  - Error escalation: on `videl:segment:error` from a child, abort the
 *    SourceBuffer queue and fire `videl:mse:error` upward.
 *
 * State lifecycle (ADR-0002 — `videl-state` attribute, not `slot`):
 *   videl-state="active" → distribute SourceBuffer; begin ABR + pump ticks.
 *   videl-state removed  → clear SourceBuffer reference; cascade deactivation.
 */
export class VidelAdaptationSet extends PickOneMixin(LitElement) {
  static properties = {
    contentType:     { type: String,  attribute: 'content-type' },
    mimeType:        { type: String,  attribute: 'mime-type' },
    codecs:          { type: String },
    label:           { type: String },
    lang:            { type: String },
    slot:            { type: String,  reflect: true },
    abrSafetyFactor: { type: Number,  attribute: 'abr-safety-factor' },
    /**
     * When set, ABR is disabled and this representation ID is always selected.
     * Set by a left-click on a video representation row; cleared automatically
     * when that representation is removed from the DOM.
     */
    forcedRepId:     { type: String,  attribute: 'forced-rep' },
    /**
     * Marks this as the synthetic "None" text adaptation set injected by the
     * MPD parser. When it becomes active, the shared TextSourceBuffer is
     * hidden rather than shown. Has no meaning on non-text ADS elements.
     */
    videlTextNone:   { type: Boolean, attribute: 'videl-text-none' },
    debug:           { type: Boolean },
  };

  contentType     = '';
  mimeType        = '';
  codecs          = '';
  label           = '';
  lang            = '';
  slot            = '';
  abrSafetyFactor = 0.8;
  forcedRepId     = '';
  videlTextNone   = false;
  debug           = false;

  /** Last full PlayerState — used for immediate re-selection after rep removal. */
  #lastState: PlayerState | null = null;

  // ── SourceBuffer ──────────────────────────────────────────────────────────

  #sourceBuffer: ISourceBuffer | null = null;

  get sourceBuffer(): ISourceBuffer | null { return this.#sourceBuffer; }
  set sourceBuffer(val: ISourceBuffer | null) { this.#sourceBuffer = val; }

  #activeMimeAndCodecs: string | null = null;

  // ── Custom element lifecycle ──────────────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback?.();
    this.addEventListener('videl:segment:error', this.#onSegmentError);
    this.addEventListener('videl:rep:select',    this.#onRepSelect as EventListener);
    this.addEventListener('videl:rep:remove',    this.#onRepRemove as EventListener);
  }

  disconnectedCallback(): void {
    this.removeEventListener('videl:segment:error', this.#onSegmentError);
    this.removeEventListener('videl:rep:select',    this.#onRepSelect as EventListener);
    this.removeEventListener('videl:rep:remove',    this.#onRepRemove as EventListener);
    super.disconnectedCallback?.();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') return;

    if (value === 'active') {
      if (!this.#sourceBuffer) {
        // The "None" text ADS has no representations and no sourceBuffer until
        // videl-player assigns it during #setupMse. If it activates before that
        // (shouldn't happen in normal flow), silently skip — no error needed.
        if (this.contentType !== 'text' || !this.videlTextNone) {
          this.dispatchEvent(
            new CustomEvent('videl:mse:error', {
              bubbles: true,
              composed: true,
              detail: { contentType: this.contentType, reason: 'missing-sourcebuffer' },
            })
          );
        }
        return;
      }
      // For text tracks: update the codec classification on the TextSourceBuffer
      // so the demuxer routes samples correctly for this ADS's format, then
      // show or hide the TextTrack.
      if (this.contentType === 'text') {
        if (this.videlTextNone) {
          this.#sourceBuffer.hide?.();
        } else {
          // Call changeType so the TextSourceBuffer resets its demuxer and
          // updates its codec class before the new representation appends its
          // init segment. This is the correct place because the ADS (not the
          // representation) owns the codec string from the MPD manifest —
          // and an ADS switch (e.g. English→French) may change the codec.
          const codecs = this.codecs
            || (this.#childRepresentations[0] as any)?.codecs
            || '';
          const mime   = this.mimeType
            || (this.#childRepresentations[0] as any)?.mimeType
            || '';
          const mimeAndCodecs = codecs ? `${mime}; codecs="${codecs}"` : mime;
          if (mimeAndCodecs) this.#sourceBuffer.changeType(mimeAndCodecs);
          this.#sourceBuffer.show?.();
        }
      }
      // Distribute SourceBuffer to every child representation before activation.
      for (const rep of this.#childRepresentations) {
        (rep as any).sourceBuffer = this.#sourceBuffer;
      }
    } else if (value === null) {
      this.#sourceBuffer        = null;
      this.#activeMimeAndCodecs = null;
    }
  }

  // ── Pump method ───────────────────────────────────────────────────────────

  videlUpdate(state: PlayerState): void {
    if (this.getAttribute('videl-state') !== 'active') return;

    this.#lastState = state;

    const target  = this.#selectRepresentation(state.bandwidth, state.playbackRate);
    if (!target) return;

    const current = this.#activeRepresentation;

    if (current !== target) {
      if (!this.#performSwitch(target, current)) {
        this.#forwardUpdate(state);
        return;
      }
    }

    this.#forwardUpdate(state);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  get #childRepresentations(): Element[] {
    return Array.from(this.children).filter(
      el => el.tagName.toLowerCase() === 'videl-representation'
    );
  }

  get #activeRepresentation(): Element | null {
    return (
      this.#childRepresentations.find(
        r => r.getAttribute('videl-state') === 'active'
      ) ?? null
    );
  }

  #selectRepresentation(bandwidth: number, playbackRate: number): Element | null {
    const reps = this.#childRepresentations;
    if (reps.length === 0) return null;

    // Forced / pinned rep: bypass ABR.
    if (this.forcedRepId) {
      const forced = reps.find(r => r.getAttribute('id') === this.forcedRepId);
      if (forced) return forced;
      // Forced rep was removed — clear the pin and fall through to ABR.
      this.removeAttribute('forced-rep');
    }

    const target = bandwidth * this.abrSafetyFactor / Math.max(playbackRate, 0.01);

    const sorted = [...reps].sort(
      (a, b) => Number((a as any).bandwidth ?? 0) - Number((b as any).bandwidth ?? 0)
    );

    let best: Element | null = null;
    for (const rep of sorted) {
      if (Number((rep as any).bandwidth ?? 0) <= target) best = rep;
    }

    return best ?? sorted[0];
  }

  #performSwitch(target: Element, prev: Element | null): boolean {
    const tRep         = target as any;
    const targetMime   = (tRep.mimeType   || this.mimeType)  ?? '';
    const targetCodecs = (tRep.codecs     || this.codecs)    ?? '';
    const newMimeAndCodecs = targetCodecs
      ? `${targetMime}; codecs="${targetCodecs}"`
      : targetMime;

    if (prev && this.#activeMimeAndCodecs && this.#activeMimeAndCodecs !== newMimeAndCodecs) {
      trace(this, 'mse', 'change-type', {
        contentType: this.contentType,
        from: this.#activeMimeAndCodecs,
        to:   newMimeAndCodecs,
      });
      try {
        this.#sourceBuffer!.changeType(newMimeAndCodecs);
      } catch {
        this.dispatchEvent(
          new CustomEvent('videl:mse:incompatible', {
            bubbles: true,
            composed: true,
            detail: { contentType: this.contentType, requiredCodecs: targetCodecs },
          })
        );
        return false;
      }
    }

    const fromId = prev
      ? ((prev as any).repId ?? (prev as any).getAttribute?.('id') ?? null)
      : null;
    const toId = tRep.repId ?? tRep.getAttribute?.('id') ?? null;

    trace(this, 'abr', fromId ? 'switch' : 'initial-select', {
      contentType:   this.contentType,
      from:          fromId,
      to:            toId,
      fromBandwidth: prev ? Number((prev as any).bandwidth ?? 0) : undefined,
      toBandwidth:   Number(tRep.bandwidth ?? 0),
    });

    tRep.sourceBuffer = this.#sourceBuffer;
    this.activateChild(target);
    this.#activeMimeAndCodecs = newMimeAndCodecs;

    if (fromId !== null) {
      this.dispatchEvent(
        new CustomEvent('videl:representation:switched', {
          bubbles: true,
          composed: true,
          detail: { from: fromId, to: toId, contentType: this.contentType },
        })
      );
    }

    return true;
  }

  #forwardUpdate(state: PlayerState): void {
    const active = this.#activeRepresentation;
    if (active) (active as any).videlUpdate(state);
  }

  /** Stamp / remove the `pinned` attribute on representations to match forcedRepId. */
  #updatePinnedAttrs(): void {
    for (const rep of this.#childRepresentations) {
      const isForced = rep.getAttribute('id') === this.forcedRepId && !!this.forcedRepId;
      if (isForced) rep.setAttribute('pinned', '');
      else          rep.removeAttribute('pinned');
    }
  }

  /**
   * Left-click on a video representation: pin it and switch immediately.
   * Dispatched as `videl:rep:select` by the representation's click handler.
   */
  #onRepSelect = (e: Event): void => {
    const rep = (e as CustomEvent).detail?.rep as Element | undefined;
    if (!(rep instanceof Element)) return;
    if (!this.#childRepresentations.includes(rep)) return;

    const repId = rep.getAttribute('id') ?? '';
    this.setAttribute('forced-rep', repId); // triggers Lit update + stores forcedRepId
    this.#updatePinnedAttrs();

    // If active, switch immediately rather than waiting for the next pump tick.
    if (this.getAttribute('videl-state') === 'active') {
      const current = this.#activeRepresentation;
      if (current !== rep) this.#performSwitch(rep, current);
    }
  };

  /**
   * Middle-click on a video representation: remove it from the DOM.
   * If it was the forced rep, clear the pin. If it was active, re-run
   * selection immediately using the last known player state.
   * Dispatched as `videl:rep:remove` by the representation's auxclick handler.
   */
  #onRepRemove = (e: Event): void => {
    const rep = (e as CustomEvent).detail?.rep as Element | undefined;
    if (!(rep instanceof Element)) return;
    if (!this.#childRepresentations.includes(rep)) return;

    const wasActive = rep.getAttribute('videl-state') === 'active';
    const wasForced = rep.getAttribute('id') === this.forcedRepId;

    rep.remove();
    if (wasForced) this.removeAttribute('forced-rep');
    this.#updatePinnedAttrs();

    // Re-run ABR immediately so there is no gap if the active rep was removed.
    if (wasActive && this.getAttribute('videl-state') === 'active' && this.#lastState) {
      this.videlUpdate(this.#lastState);
    }
  };

  /**
   * Left-click on an audio track row: let the parent period handle the
   * switch (it needs to trim the source buffer before activating the new ADS).
   * Dispatched as `videl:track:select`.
   */
  #onTrackClick = (): void => {
    // Audio and text tracks are selectable; video quality uses its own mechanism.
    if (this.contentType !== 'audio' && this.contentType !== 'text') return;
    if (this.getAttribute('videl-state') === 'active') return;
    this.dispatchEvent(new CustomEvent('videl:track:select', {
      bubbles:  true,
      composed: true,
      detail:   { ads: this },
    }));
  };

  #onSegmentError = (event: Event): void => {
    const detail = (event as CustomEvent).detail;
    if (this.#sourceBuffer && this.contentType !== 'text') {
      this.#sourceBuffer.abort().catch(() => {});
    }
    this.dispatchEvent(
      new CustomEvent('videl:mse:error', {
        bubbles: true,
        composed: true,
        detail: {
          contentType: this.contentType,
          reason: detail?.error?.message ?? 'segment-error',
        },
      })
    );
  };

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    const active = this.getAttribute('videl-state') === 'active';
    // Audio/text adaptation sets present as a single selectable track row.
    // The label is computed by the parser with priority: Label child element, label attribute, lang attribute, contentType, 'track'
    const label = this.label || this.contentType || 'track';

    return html`
      <style>
        :host { display: block; box-sizing: border-box; }

        /* ── Track row (audio / text) ─────────────────────────────── */
        .track {
          padding: 6px 8px;
          margin: 1px 0;
          color: #ddd;
          font-family: ui-monospace, monospace;
          font-size: 12px;
          display: flex;
          justify-content: space-between;
          gap: 8px;
          cursor: default;
        }
        /* Inactive audio and text tracks are selectable. */
        :host([content-type="audio"]:not([videl-state="active"])) .track,
        :host([content-type="text"]:not([videl-state="active"])) .track {
          cursor: pointer;
        }
        :host([videl-state="active"]) .track {
          background: rgba(79, 156, 249, 0.25);
          color: #fff;
        }
        /* For video the row is suppressed — the representations ARE the menu. */
        :host([content-type="video"]) .track { display: none; }

        /*
         * Representations are technical children: hidden by default. For the
         * video adaptation set they form the quality list and are revealed.
         * (important flag for the same ::slotted vs :host cascade reason.)
         */
        ::slotted(videl-representation) { display: none !important; }
        :host([content-type="video"]) ::slotted(videl-representation) {
          display: block !important;
        }
      </style>

      <div class="track" title="${label}" aria-label="${label}"
           @click=${this.#onTrackClick}>
        <span>${label}</span>
        <span>${active ? '✓' : ''}</span>
      </div>
      <slot></slot>

      ${this.debug ? html`
        <div style="font-family:monospace;font-size:11px;border:1px solid #8a8;padding:4px;margin-top:4px;background:rgba(0,0,0,0.6);color:#fff">
          <strong>videl-adaptation-set</strong>
          type=<em>${this.contentType}</em>
          state=<em>${this.getAttribute('videl-state') ?? 'idle'}</em>
          abr=<em>${this.abrSafetyFactor}</em>
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('videl-adaptation-set', VidelAdaptationSet);
