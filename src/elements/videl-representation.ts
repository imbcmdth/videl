import { LitElement, html, nothing } from 'lit';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import type { PlayerState } from '../player-state';
import type { ManagedSourceBuffer } from '../managed-source-buffer';
import { trace } from '../trace';

// ---------------------------------------------------------------------------
// SourceBuffer-aware buffering utilities.
//
// Both functions operate on a single SourceBuffer's TimeRanges rather than
// the video element's combined `.buffered`, because:
//  - video.buffered is the INTERSECTION of all SourceBuffers — if audio lags,
//    it makes video appear less buffered than it actually is.
//  - Each representation owns exactly one SourceBuffer and should make fetch
//    decisions based on that buffer's state alone.
// ---------------------------------------------------------------------------

/**
 * Returns true when [startTime, startTime+duration) is fully covered by the
 * given TimeRanges. A 0.1 s tolerance handles floating-point imprecision in
 * browser-reported buffer boundaries.
 */
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
 * Find the TimeRange that contains `t` (with 0.1 s tolerance) and return how
 * many seconds extend past `t` to the end of that range.
 *
 * Returns 0 when `t` falls in a gap — this correctly signals that we need to
 * fetch, even if other ranges exist further along the timeline.  Non-contiguous
 * buffers are handled by the segment-selection walk: once a gap is filled the
 * next tick will find a longer contiguous range and suppress further fetches.
 */
function bufferedAhead(t: number, buffered: TimeRanges): number {
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= t + 0.1 && buffered.end(i) > t) {
      return buffered.end(i) - t;
    }
  }
  return 0; // t is in a gap or before any buffered range
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
  slot = '';
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
      // Abort any in-flight init fetch.
      this.#initController?.abort();
      this.#initController = null;
      this.#initPromise    = null;
      // Reset initAppended so the init segment is always re-sent to the
      // SourceBuffer on the next activation.
      //
      // Why: the SourceBuffer is shared across all representations of this
      // AdaptationSet.  When a different representation is active in between,
      // it appends its own init segment, reconfiguring the SourceBuffer's
      // decoder parameters.  If we skipped re-sending our init here (the old
      // behaviour), our media segments would be decoded against the wrong
      // parameters → MSE errors / corrupted frames.
      //
      // Cost: one extra small network request (~1–4 KB moov box) per
      // re-activation — negligible compared to media segment sizes.
      this.#initAppended = false;
    }
  }

  // ── Public pump method ────────────────────────────────────────────────────

  /**
   * Called by the parent adaptation-set on each pump tick when `slot=active`.
   * Selects the correct segment to fetch/append based on currentTime and
   * buffer state. Already-buffered segments are skipped (not re-fetched).
   *
   * Named `videlUpdate` (not `update`) to avoid colliding with LitElement's
   * internal `update(changedProperties)` lifecycle method.
   */
  videlUpdate(state: PlayerState): void {
    if (!this.#initAppended) return;
    if (this.getAttribute('slot') !== 'active') return;
    if (!this.#sourceBuffer) return;

    // Resolve this representation's buffered TimeRanges from the state snapshot
    // (preferred — no direct SourceBuffer access needed in the hot path) using
    // the parent adaptation set's content-type as the lookup key.
    // Falls back to reading from the SourceBuffer directly when running outside
    // a full player context (e.g. unit tests with a mock MSB).
    const contentType = this.closest('videl-adaptation-set')
      ?.getAttribute('content-type') ?? '';
    const sbBuffered: TimeRanges =
      state.sourceBuffered?.get(contentType) ?? this.#sourceBuffer.buffered;

    const { currentTime, bufferAhead } = state;

    // Suppress all fetching while the contiguous buffered run from currentTime
    // is already long enough.  If currentTime is in a gap, bufferedAhead returns
    // 0, so fetching is always allowed — we fill gaps before extending the buffer.
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

    // 1. Find the segment whose time range covers currentTime.
    let startIdx = segs.findIndex(
      s => s.startTime <= currentTime && currentTime < s.startTime + s.duration
    );
    // If currentTime precedes all segments, start from the beginning.
    if (startIdx < 0) {
      startIdx = currentTime < segs[0].startTime ? 0 : -1;
    }
    if (startIdx < 0) return; // currentTime is past the last segment

    // 2. Walk forward past segments already present in the SourceBuffer.
    //    This fills gaps: if [0-10] and [15-30] are buffered and currentTime=5,
    //    we skip segment 0 (buffered), land on the segment covering 10-15 (gap),
    //    and fetch it.
    let targetIdx = startIdx;
    while (
      targetIdx < segs.length &&
      isBuffered(segs[targetIdx].startTime, segs[targetIdx].duration, sbBuffered)
    ) {
      targetIdx++;
    }
    if (targetIdx >= segs.length) return; // every segment ahead is buffered

    const target = segs[targetIdx];
    if (target.getAttribute('slot') !== 'active') {
      trace(this, 'pump', 'segment-activate', {
        startTime: (target as any).startTime,
        duration:  (target as any).duration,
        url:       (target as any).url,
      });
      target.sourceBuffer = this.#sourceBuffer;
      this.activateChild(target); // PickOneMixin deactivates any previous active segment
    }

    // 3. Find the next unbuffered segment after the target and queue it for
    //    prefetch, skipping any that are already in the SourceBuffer.
    let nextIdx = targetIdx + 1;
    while (
      nextIdx < segs.length &&
      isBuffered(segs[nextIdx].startTime, segs[nextIdx].duration, sbBuffered)
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

    trace(this, 'fetch', 'init-fetch-start', { url: this.initializationUrl });
    this.#initController = new AbortController();
    this.#initPromise = this.#doFetchInit(this.#initController.signal)
      .then(() => {
        this.#initAppended = true;
        trace(this, 'buffer', 'init-append-complete', { url: this.initializationUrl });
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
      slot=<em>${this.slot || 'unslotted'}</em>
      init=<em>${this.#initAppended ? 'done' : 'pending'}</em>
      <slot name="active"></slot>
      <slot name="next"></slot>
    `;
  }
}

customElements.define('videl-representation', VidelRepresentation);
