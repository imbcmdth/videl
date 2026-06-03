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
 *  - ABR: on each `update()` tick, select the highest-bandwidth representation
 *    whose bitrate ≤ `bandwidth × abrSafetyFactor / playbackRate`.
 *  - SourceBuffer distribution: forward the `ManagedSourceBuffer` received from
 *    `<videl-player>` to all child representations before activation.
 *  - Codec change: if an ABR switch requires a different codec, attempt
 *    `sourceBuffer.changeType()`; fire `videl:mse:incompatible` if that fails.
 *  - Error escalation: on `videl:segment:error` from a child, abort the
 *    SourceBuffer queue and fire `videl:mse:error` upward.
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
  slot = '';
  /** Highest-bandwidth representation chosen ≤ `bandwidth × factor / playbackRate`. */
  abrSafetyFactor = 0.8;
  debug           = false;

  // ── SourceBuffer ──────────────────────────────────────────────────────────

  #sourceBuffer: ManagedSourceBuffer | null = null;

  /** Set by `<videl-player>` before this element is activated. */
  get sourceBuffer(): ManagedSourceBuffer | null {
    return this.#sourceBuffer;
  }
  set sourceBuffer(val: ManagedSourceBuffer | null) {
    this.#sourceBuffer = val;
  }

  /** MIME+codecs string of the currently active representation. */
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
    // Super chain: LitElement updates the reactive property; PickOneMixin
    // cascades deactivation when slot is removed.
    super.attributeChangedCallback(name, old, value);

    if (name !== 'slot') return;

    // Accept both direct activation ('active') and PickNMixin keyed activation
    // ('video-active', 'audio-active', etc.) — VidelPeriod uses PickNMixin
    // which stamps 'contentType-active' rather than plain 'active'.
    const isActive = value !== null && (value === 'active' || value.endsWith('-active'));

    if (isActive) {
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
      // Distribute SourceBuffer to every child representation before any is
      // activated (criterion 2 — done here so it is set even before the
      // first videlUpdate() call).
      for (const rep of this.#childRepresentations) {
        (rep as any).sourceBuffer = this.#sourceBuffer;
      }
    } else if (value === null) {
      // Clear the SourceBuffer reference; do NOT call removeSourceBuffer
      // (criterion 8).
      this.#sourceBuffer        = null;
      this.#activeMimeAndCodecs = null;
    }
  }

  // ── Pump method ───────────────────────────────────────────────────────────

  /**
   * Called by the parent period on each pump tick while `slot=active`.
   *
   * 1. Run ABR — select the best representation for current bandwidth.
   * 2. If the selection changed, attempt the switch (codec check, changeType).
   * 3. Forward the full PlayerState to the active representation.
   */
  /** Named `videlUpdate` to avoid colliding with LitElement's `update()` lifecycle. */
  videlUpdate(state: PlayerState): void {
    // Accept 'active' (direct) and 'video-active' / 'audio-active' (via PickNMixin).
    const slot = this.getAttribute('slot');
    if (!slot || !(slot === 'active' || slot.endsWith('-active'))) return;

    const target  = this.#selectRepresentation(state.bandwidth, state.playbackRate);
    if (!target) return;

    const current = this.#activeRepresentation;

    if (current !== target) {
      if (!this.#performSwitch(target, current)) {
        // Switch blocked — continue forwarding to the current representation.
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
      this.#childRepresentations.find(r => r.getAttribute('slot') === 'active') ?? null
    );
  }

  /**
   * Select the highest-bandwidth representation whose bitrate does not exceed
   * `bandwidth × abrSafetyFactor / playbackRate`. Falls back to the
   * lowest-bandwidth representation when all exceed the target (e.g. on a
   * very slow connection).
   */
  #selectRepresentation(bandwidth: number, playbackRate: number): Element | null {
    const reps = this.#childRepresentations;
    if (reps.length === 0) return null;

    const target = bandwidth * this.abrSafetyFactor / Math.max(playbackRate, 0.01);

    // Sort ascending by bandwidth for a stable pass.
    const sorted = [...reps].sort(
      (a, b) => Number((a as any).bandwidth ?? 0) - Number((b as any).bandwidth ?? 0)
    );

    // Walk sorted list; keep the last one that fits.
    let best: Element | null = null;
    for (const rep of sorted) {
      if (Number((rep as any).bandwidth ?? 0) <= target) {
        best = rep;
      }
    }

    // If nothing fits, fall back to the lowest bandwidth option.
    return best ?? sorted[0];
  }

  /**
   * Switch the active representation to `target`.
   *
   * Returns `false` (and fires `videl:mse:incompatible`) if the codec change
   * required to use the new representation cannot be performed.
   */
  #performSwitch(target: Element, prev: Element | null): boolean {
    const tRep = target as any;
    // Resolved mime+codecs: representation's own value, or fall back to
    // the adaptation set's defaults (codecs are inherited at parse time
    // but may not always be present on the representation element).
    const targetMime   = (tRep.mimeType   || this.mimeType)  ?? '';
    const targetCodecs = (tRep.codecs     || this.codecs)    ?? '';
    const newMimeAndCodecs = targetCodecs
      ? `${targetMime}; codecs="${targetCodecs}"`
      : targetMime;

    // Detect whether a codec change is needed.
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
        return false; // Abort the switch; castro will rebuild.
      }
    }

    const fromId = prev
      ? ((prev as any).repId ?? (prev as any).getAttribute?.('id') ?? null)
      : null;
    const toId = tRep.repId ?? tRep.getAttribute?.('id') ?? null;

    trace(this, 'abr', fromId ? 'switch' : 'initial-select', {
      contentType: this.contentType,
      from:        fromId,
      to:          toId,
      fromBandwidth: prev ? Number((prev as any).bandwidth ?? 0) : undefined,
      toBandwidth:   Number(tRep.bandwidth ?? 0),
    });

    // Ensure sourceBuffer is set on the target before it is activated.
    tRep.sourceBuffer = this.#sourceBuffer;

    // PickOneMixin.activateChild removes the previous child's slot first,
    // which triggers the null handler on the old representation and resets
    // its #initAppended flag — see VidelRepresentation.attributeChangedCallback.
    this.activateChild(target);
    this.#activeMimeAndCodecs = newMimeAndCodecs;

    // Fire the switch event only when there was a previous representation
    // (first activation is not a "switch").
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

  /**
   * Per ADR-0001 first-line error handling: abort the SourceBuffer queue and
   * escalate as `videl:mse:error`. A full abort+retry path is a future
   * enhancement (not required by V1 tests).
   */
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
    if (!this.debug) return nothing;
    return html`
      <style>
        :host { display: block; font-family: monospace; font-size: 11px;
                border: 1px solid #8a8; padding: 4px; margin: 2px; }
      </style>
      <strong>videl-adaptation-set</strong>
      type=<em>${this.contentType}</em>
      slot=<em>${this.slot || 'unslotted'}</em>
      abr=<em>${this.abrSafetyFactor}</em>
      <slot name="active"></slot>
      <slot name="next"></slot>
    `;
  }
}

customElements.define('videl-adaptation-set', VidelAdaptationSet);
