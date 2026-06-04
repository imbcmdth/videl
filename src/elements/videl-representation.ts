import { LitElement, html, nothing } from 'lit';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import type { PlayerState } from '../player-state';
import type { ManagedSourceBuffer } from '../managed-source-buffer';
import { trace } from '../trace';

// ---------------------------------------------------------------------------
// SourceBuffer-aware buffering utilities.
// ---------------------------------------------------------------------------

function isBuffered(startTime: number, duration: number, buffered: TimeRanges): boolean {
  const end = startTime + duration;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= startTime + 0.1 && buffered.end(i) >= end - 0.1) {
      return true;
    }
  }
  return false;
}

function bufferedAhead(t: number, buffered: TimeRanges): number {
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= t + 0.1 && buffered.end(i) > t) {
      return buffered.end(i) - t;
    }
  }
  return 0;
}

/**
 * `<videl-representation>` — owns a set of `<videl-segment>` children for a
 * single quality level.
 *
 * State lifecycle (ADR-0002 — `videl-state` attribute, not `slot`):
 *   videl-state="next"   → fetch + append the initialization segment (moov box).
 *   videl-state="active" → begin receiving `videlUpdate(PlayerState)` pump calls;
 *                          select and activate the correct segment on each tick.
 *   videl-state removed  → cascade-deactivate all child segments (PickOneMixin).
 */
export class VidelRepresentation extends PickOneMixin(LitElement) {
  static properties = {
    repId:                  { type: String,  attribute: 'id' },
    bandwidth:              { type: Number },
    width:                  { type: Number },
    height:                 { type: Number },
    codecs:                 { type: String },
    mimeType:               { type: String,  attribute: 'mime-type' },
    initializationUrl:      { type: String,  attribute: 'initialization-url' },
    initializationByteRange:{ type: String,  attribute: 'initialization-byte-range' },
    slot:                   { type: String,  reflect: true },
    debug:                  { type: Boolean },
  };

  repId                    = '';
  bandwidth                = 0;
  width                    = 0;
  height                   = 0;
  codecs                   = '';
  mimeType                 = '';
  initializationUrl        = '';
  initializationByteRange: string | null = null;
  slot                     = '';
  debug                    = false;

  // ── sourceBuffer — resets init state when a new buffer is assigned ────────

  #sourceBuffer: ManagedSourceBuffer | null = null;

  get sourceBuffer(): ManagedSourceBuffer | null { return this.#sourceBuffer; }

  set sourceBuffer(val: ManagedSourceBuffer | null) {
    if (val === this.#sourceBuffer) return;
    this.#initController?.abort();
    this.#initController = null;
    this.#initPromise    = null;
    this.#initAppended   = false;
    this.#sourceBuffer   = val;
    // If we already have a videl-state set and a valid buffer, start init now.
    if (val && this.getAttribute('videl-state')) {
      this.#startInit();
    }
  }

  // ── Init segment state ────────────────────────────────────────────────────

  #initAppended   = false;
  #initController: AbortController | null = null;
  #initPromise:    Promise<void> | null   = null;

  // ── State lifecycle ───────────────────────────────────────────────────────

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') return;

    if (value === 'next' || value === 'active') {
      this.#startInit();
    } else if (value === null) {
      this.#initController?.abort();
      this.#initController = null;
      this.#initPromise    = null;
      // Reset so the init segment is always re-sent on the next activation.
      // The SourceBuffer is shared across representations; a different rep may
      // have reconfigured the decoder while we were inactive.
      this.#initAppended = false;
    }
  }

  // ── Public pump method ────────────────────────────────────────────────────

  videlUpdate(state: PlayerState): void {
    if (!this.#initAppended) return;
    if (this.getAttribute('videl-state') !== 'active') return;
    if (!this.#sourceBuffer) return;

    const contentType = this.closest('videl-adaptation-set')
      ?.getAttribute('content-type') ?? '';
    const sbBuffered: TimeRanges =
      state.sourceBuffered?.get(contentType) ?? this.#sourceBuffer.buffered;

    const { currentTime, bufferAhead } = state;

    const ahead = bufferedAhead(currentTime, sbBuffered);
    if (ahead >= bufferAhead) {
      trace(this, 'pump', 'buffer-full', {
        bufferedAhead: +ahead.toFixed(2),
        bufferAhead,
      });
      return;
    }

    const segs = this.#childSegments;
    if (segs.length === 0) return;

    let startIdx = segs.findIndex(
      s => s.startTime <= currentTime && currentTime < s.startTime + s.duration
    );
    if (startIdx < 0) {
      startIdx = currentTime < segs[0].startTime ? 0 : -1;
    }
    if (startIdx < 0) return;

    let targetIdx = startIdx;
    while (
      targetIdx < segs.length &&
      isBuffered(segs[targetIdx].startTime, segs[targetIdx].duration, sbBuffered)
    ) {
      targetIdx++;
    }
    if (targetIdx >= segs.length) return;

    const target = segs[targetIdx];
    if (target.getAttribute('videl-state') !== 'active') {
      trace(this, 'pump', 'segment-activate', {
        startTime: (target as any).startTime,
        duration:  (target as any).duration,
        url:       (target as any).url,
      });
      target.sourceBuffer = this.#sourceBuffer;
      this.activateChild(target);
    }

    let nextIdx = targetIdx + 1;
    while (
      nextIdx < segs.length &&
      isBuffered(segs[nextIdx].startTime, segs[nextIdx].duration, sbBuffered)
    ) {
      nextIdx++;
    }
    if (nextIdx < segs.length) {
      const next = segs[nextIdx];
      if (next.getAttribute('videl-state') !== 'next') {
        next.sourceBuffer = this.#sourceBuffer;
        this.preloadChild(next);
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  get #childSegments(): any[] {
    return Array.from(this.children).filter(
      el => el.tagName.toLowerCase() === 'videl-segment'
    ) as any[];
  }

  #startInit(): void {
    if (this.#initAppended) return;
    if (this.#initPromise)  return;
    if (!this.#sourceBuffer) return;
    if (!this.initializationUrl) return;

    trace(this, 'fetch', 'init-fetch-start', { url: this.initializationUrl });
    this.#initController = new AbortController();
    this.#initPromise = this.#doFetchInit(this.#initController.signal)
      .then(() => {
        this.#initAppended = true;
        trace(this, 'buffer', 'init-append-complete', { url: this.initializationUrl });
      })
      .catch((err: unknown) => {
        if (this.getAttribute('videl-state') === null) return;
        this.dispatchEvent(
          new CustomEvent('videl:segment:error', {
            bubbles: true,
            composed: true,
            detail: { error: err instanceof Error ? err : new Error(String(err)) },
          })
        );
      })
      .finally(() => {
        this.#initPromise = null;
      });
  }

  async #doFetchInit(signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.initializationByteRange) {
      headers['Range'] = `bytes=${this.initializationByteRange}`;
    }
    const resp = await fetch(this.initializationUrl, { signal, headers });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching init segment ${this.initializationUrl}`);
    }
    const bytes = await resp.arrayBuffer();
    await this.#sourceBuffer!.append(bytes);
  }

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    return html`
      <style>
        :host { display: block; }
        ::slotted(videl-segment) { display: none; }
      </style>
      <slot></slot>
      ${this.debug ? html`
        <div style="font-family:monospace;font-size:11px;border:1px solid #88a;padding:4px;margin-top:4px">
          <strong>videl-representation</strong>
          id=<em>${this.repId}</em>
          bw=<em>${this.bandwidth}</em>
          state=<em>${this.getAttribute('videl-state') ?? 'idle'}</em>
          init=<em>${this.#initAppended ? 'done' : 'pending'}</em>
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('videl-representation', VidelRepresentation);
