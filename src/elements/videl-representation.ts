import { LitElement, html, nothing } from 'lit';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import type { PlayerState } from '../player-state';
import type { ManagedSourceBuffer } from '../managed-source-buffer';

// ---------------------------------------------------------------------------
// Utility: check whether [startTime, startTime+duration) is fully covered by
// a TimeRanges object. A small tolerance (0.1 s) handles float imprecision.
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

/**
 * `<videl-representation>` — owns a set of `<videl-segment>` children for a
 * single quality level.
 *
 * Slot lifecycle:
 *   next   → fetch + append the initialization segment (moov box).
 *   active → begin receiving `update(PlayerState)` pump calls; select and
 *            activate the correct segment on each tick.
 *   null   → cascade-deactivate all child segments (via PickOneMixin).
 *
 * The init segment must be appended before any media segment can be played.
 * If `slot=active` arrives before the init fetch finishes (direct activation
 * without prior `slot=next`), it is fetched inline. `update()` calls are
 * silently dropped until init completes.
 *
 * Segment selection in `update()`:
 *   1. Find the segment whose [start-time, start-time+duration) covers
 *      currentTime.
 *   2. Walk forward past any already-buffered segments to find the first one
 *      still needing a fetch → activate it.
 *   3. Walk forward from there to find the next unbuffered segment → preload
 *      it (slot=next).
 *   Advancement between segments is driven entirely by successive `update()`
 *   calls, NOT by `videl:done` events (criterion 8).
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

  repId                   = '';
  bandwidth               = 0;
  width                   = 0;
  height                  = 0;
  codecs                  = '';
  mimeType                = '';
  initializationUrl       = '';
  initializationByteRange: string | null = null;
  slot: string | undefined = undefined;
  debug                   = false;

  // ── sourceBuffer — resets init state when a new buffer is assigned ────────

  #sourceBuffer: ManagedSourceBuffer | null = null;

  get sourceBuffer(): ManagedSourceBuffer | null {
    return this.#sourceBuffer;
  }

  set sourceBuffer(val: ManagedSourceBuffer | null) {
    if (val === this.#sourceBuffer) return;
    // Abort any in-flight init fetch against the old buffer.
    this.#initController?.abort();
    this.#initController = null;
    this.#initPromise    = null;
    this.#initAppended   = false;
    this.#sourceBuffer   = val;
    // If we are already slotted and have a valid buffer, start init now.
    // (Handles the edge case where sourceBuffer is set after slot.)
    if (val && this.getAttribute('slot')) {
      this.#startInit();
    }
  }

  // ── Init segment state ────────────────────────────────────────────────────

  #initAppended   = false;
  #initController: AbortController | null = null;
  #initPromise:   Promise<void> | null = null;

  // ── Slot lifecycle ────────────────────────────────────────────────────────

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    // PickOneMixin + LitElement super chain (cascade deactivation happens here).
    super.attributeChangedCallback(name, old, value);

    if (name !== 'slot') return;

    if (value === 'next' || value === 'active') {
      this.#startInit();
    } else if (value === null) {
      // Abort the in-flight init fetch if any; keep #initAppended intact so
      // re-activation with the same SourceBuffer skips the init re-fetch.
      this.#initController?.abort();
      this.#initController = null;
      this.#initPromise    = null;
    }
  }

  // ── Public pump method ────────────────────────────────────────────────────

  /**
   * Called by the parent adaptation-set on each pump tick when `slot=active`.
   * Selects the correct segment to fetch/append based on currentTime and
   * buffer state. Already-buffered segments are skipped (not re-fetched).
   */
  update(state: PlayerState): void {
    if (!this.#initAppended) return;
    if (this.getAttribute('slot') !== 'active') return;

    const { currentTime, buffered } = state;
    const segs = this.#childSegments;
    if (segs.length === 0) return;

    // 1. Find the index of the segment whose range covers currentTime.
    let startIdx = segs.findIndex(
      s => s.startTime <= currentTime && currentTime < s.startTime + s.duration
    );
    // If currentTime precedes all segments, start from the beginning.
    if (startIdx < 0) {
      startIdx = currentTime < segs[0].startTime ? 0 : -1;
    }
    if (startIdx < 0) return; // currentTime is past the last segment

    // 2. Walk forward past already-buffered segments to find the work target.
    let targetIdx = startIdx;
    while (
      targetIdx < segs.length &&
      isBuffered(segs[targetIdx].startTime, segs[targetIdx].duration, buffered)
    ) {
      targetIdx++;
    }
    if (targetIdx >= segs.length) return; // everything ahead is buffered

    const target = segs[targetIdx];
    if (target.getAttribute('slot') !== 'active') {
      target.sourceBuffer = this.#sourceBuffer;
      this.activateChild(target); // PickOneMixin removes the previous active child
    }

    // 3. Find the next unbuffered segment after the target for prefetching.
    let nextIdx = targetIdx + 1;
    while (
      nextIdx < segs.length &&
      isBuffered(segs[nextIdx].startTime, segs[nextIdx].duration, buffered)
    ) {
      nextIdx++;
    }
    if (nextIdx < segs.length) {
      const next = segs[nextIdx];
      if (next.getAttribute('slot') !== 'next') {
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

    this.#initController = new AbortController();
    this.#initPromise = this.#doFetchInit(this.#initController.signal)
      .then(() => {
        this.#initAppended = true;
      })
      .catch((err: unknown) => {
        if (this.getAttribute('slot') === null) return;
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
    if (!this.debug) return nothing;
    return html`
      <style>
        :host { display: block; font-family: monospace; font-size: 11px;
                border: 1px solid #88a; padding: 4px; margin: 2px; }
      </style>
      <strong>videl-representation</strong>
      id=<em>${this.repId}</em>
      bw=<em>${this.bandwidth}</em>
      slot=<em>${this.slot ?? 'unslotted'}</em>
      init=<em>${this.#initAppended ? 'done' : 'pending'}</em>
      <slot name="active"></slot>
      <slot name="next"></slot>
    `;
  }
}

customElements.define('videl-representation', VidelRepresentation);
