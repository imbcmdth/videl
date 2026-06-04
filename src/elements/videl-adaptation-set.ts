import { LitElement, html, nothing } from 'lit';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import type { PlayerState } from '../player-state';
import type { ManagedSourceBuffer } from '../managed-source-buffer';
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
    lang:            { type: String },
    slot:            { type: String,  reflect: true },
    abrSafetyFactor: { type: Number,  attribute: 'abr-safety-factor' },
    debug:           { type: Boolean },
  };

  contentType     = '';
  mimeType        = '';
  codecs          = '';
  lang            = '';
  slot            = '';
  abrSafetyFactor = 0.8;
  debug           = false;

  // ── SourceBuffer ──────────────────────────────────────────────────────────

  #sourceBuffer: ManagedSourceBuffer | null = null;

  get sourceBuffer(): ManagedSourceBuffer | null { return this.#sourceBuffer; }
  set sourceBuffer(val: ManagedSourceBuffer | null) { this.#sourceBuffer = val; }

  #activeMimeAndCodecs: string | null = null;

  // ── Custom element lifecycle ──────────────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback?.();
    this.addEventListener('videl:segment:error', this.#onSegmentError);
  }

  disconnectedCallback(): void {
    this.removeEventListener('videl:segment:error', this.#onSegmentError);
    super.disconnectedCallback?.();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') return;

    if (value === 'active') {
      if (!this.#sourceBuffer) {
        this.dispatchEvent(
          new CustomEvent('videl:mse:error', {
            bubbles: true,
            composed: true,
            detail: { contentType: this.contentType, reason: 'missing-sourcebuffer' },
          })
        );
        return;
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

  #onSegmentError = (event: Event): void => {
    const detail = (event as CustomEvent).detail;
    if (this.#sourceBuffer) {
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
    return html`
      <style>
        :host { display: block; }
        ::slotted(videl-representation) { display: none; }
      </style>
      <slot></slot>
      ${this.debug ? html`
        <div style="font-family:monospace;font-size:11px;border:1px solid #8a8;padding:4px;margin-top:4px">
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
