import { LitElement, html, nothing } from 'lit';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import type { PlayerState } from '../player-state';
import type { ManagedSourceBuffer } from '../managed-source-buffer';
import { trace } from '../trace';

// ---------------------------------------------------------------------------
// Buffering utilities
// ---------------------------------------------------------------------------

/**
 * True when the segment whose declared range is [startTime, startTime+duration]
 * is substantially present in the SourceBuffer.
 *
 * The original check used a tight 0.1 s absolute tolerance which broke on any
 * stream where the encoder emits slightly less media than the declared duration
 * (very common: priming samples, splice points, non-zero start PTS, etc.).
 *
 * Tolerance policy: max(0.5 s, 15 % of declared duration).  This handles the
 * common ±10 % encoder variation while still catching genuinely partial appends.
 */
function isBuffered(startTime: number, duration: number, buffered: TimeRanges): boolean {
  const tolerance = Math.max(0.5, duration * 0.15);
  const minEnd    = startTime + duration - tolerance;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= startTime + 0.1 && buffered.end(i) >= minEnd) {
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
 * End of the buffered range covering `t` (±0.1 s tolerance).
 * Returns null if no range covers `t`.
 */
function bufferEndNear(t: number, buffered: TimeRanges): number | null {
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= t + 0.1 && buffered.end(i) > t) {
      return buffered.end(i);
    }
  }
  return null;
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
 *
 * ### Segment selection and timeline drift
 *
 * MPEG-DASH manifests declare segment start times and durations. In practice the
 * actual buffered duration after an append can differ from the declaration due to
 * encoder priming samples, non-zero start PTS, splicer adjustments, and similar
 * real-world factors. This drift accumulates: if segment 0 buffers 3.669 s when
 * the manifest said 3.84 s, the buffer frontier sits at 3.669 s while the next
 * segment's declared start is 3.84 s — a 0.171 s gap.
 *
 * Two mechanisms keep the pump from getting stuck:
 *
 * 1. `#fetchedSegments` — a Set of segment elements dispatched to the SourceBuffer
 *    in the current activation session.  The pump walk skips entries in this set
 *    so it never retries a segment just because `isBuffered` disagrees about the
 *    exact end time.
 *
 * 2. `#timelineDrift` — cumulative offset (seconds) between actual SourceBuffer
 *    end time and MPD-declared end time, updated via a `videl:done` listener
 *    after every append.  All subsequent segment selection uses
 *    `startTime + timelineDrift` as the effective position, keeping the walk
 *    aligned with reality even after large drifts in either direction.
 */
export class VidelRepresentation extends PickOneMixin(LitElement) {
  static properties = {
    repId:                   { type: String,  attribute: 'id' },
    bandwidth:               { type: Number },
    width:                   { type: Number },
    height:                  { type: Number },
    codecs:                  { type: String },
    mimeType:                { type: String,  attribute: 'mime-type' },
    initializationUrl:       { type: String,  attribute: 'initialization-url' },
    initializationByteRange: { type: String,  attribute: 'initialization-byte-range' },
    slot:                    { type: String,  reflect: true },
    debug:                   { type: Boolean },
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

  // ── SourceBuffer ──────────────────────────────────────────────────────────

  #sourceBuffer: ManagedSourceBuffer | null = null;

  get sourceBuffer(): ManagedSourceBuffer | null { return this.#sourceBuffer; }

  set sourceBuffer(val: ManagedSourceBuffer | null) {
    if (val === this.#sourceBuffer) return;
    this.#initController?.abort();
    this.#initController = null;
    this.#initPromise    = null;
    this.#initAppended   = false;
    // A new SourceBuffer means the buffer has been cleared; the old fetch
    // history, drift offset, and position tracking are no longer valid.
    this.#fetchedSegments.clear();
    this.#timelineDrift  = 0;
    this.#lastCurrentTime = -1;
    this.#sourceBuffer  = val;
    if (val && this.getAttribute('videl-state')) {
      this.#startInit();
    }
  }

  // ── Init segment state ────────────────────────────────────────────────────

  #initAppended   = false;
  #initController: AbortController | null = null;
  #initPromise:    Promise<void> | null   = null;

  // ── Segment timeline tracking ─────────────────────────────────────────────

  /**
   * Segments dispatched to the SourceBuffer in the current activation session.
   * Prevents the pump walk from retrying an already-fetched segment when the
   * actual buffered duration is slightly less than the declared duration.
   *
   * Cleared on:
   *  - seek (detected in videlUpdate — new currentTime is not buffered)
   *  - sourceBuffer reassignment (MSE rebuild)
   *  - videl-state removal (deactivation)
   *
   * On seek we cannot know what the browser has evicted from the SourceBuffer,
   * so treating every segment as un-fetched and re-evaluating via isBuffered is
   * the only safe approach.  Combined with ABR switches the stale set could
   * otherwise direct the walk to skip segments that are no longer present.
   */
  #fetchedSegments = new Set<Element>();

  /**
   * Cumulative timeline drift (seconds): actual_buffer_end − mpd_declared_end.
   * Updated after every segment append via `videl:done`.
   *   Negative → segments are running shorter than declared (most common).
   *   Positive → segments are running longer than declared.
   * Applied as an offset to all declared `startTime` values when selecting the
   * next segment to fetch, so the walk stays aligned with the real buffer.
   * Also cleared on seek — the drift is only meaningful relative to a
   * continuous run of appends from a known starting position.
   */
  #timelineDrift = 0;

  /** Last `currentTime` seen by videlUpdate — used for seek detection. */
  #lastCurrentTime = -1;

  // ── Custom element lifecycle ──────────────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback();
    (this as unknown as HTMLElement).addEventListener('videl:done', this.#onSegmentDone);
  }

  disconnectedCallback(): void {
    (this as unknown as HTMLElement).removeEventListener('videl:done', this.#onSegmentDone);
    super.disconnectedCallback();
  }

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
      this.#initAppended = false;
      // Clear fetch history, drift, and position tracking — fresh activation.
      this.#fetchedSegments.clear();
      this.#timelineDrift   = 0;
      this.#lastCurrentTime = -1;
    }
  }

  // ── Pump method ───────────────────────────────────────────────────────────

  videlUpdate(state: PlayerState): void {
    if (!this.#initAppended) return;
    if (this.getAttribute('videl-state') !== 'active') return;
    if (!this.#sourceBuffer) return;

    const contentType = this.closest('videl-adaptation-set')
      ?.getAttribute('content-type') ?? '';
    const sbBuffered: TimeRanges =
      state.sourceBuffered?.get(contentType) ?? this.#sourceBuffer.buffered;

    const { currentTime, bufferAhead } = state;

    // ── Seek detection ────────────────────────────────────────────────────
    // If currentTime has jumped significantly AND the new position is not
    // covered by the SourceBuffer, treat it as a seek.  After a seek:
    //   - The browser may have evicted any portion of the buffered content.
    //   - #fetchedSegments is stale and cannot be trusted.
    //   - #timelineDrift was calculated relative to the previous run of appends
    //     and is meaningless at the new position.
    // Clearing both lets isBuffered re-evaluate what is actually present and
    // the walk restart cleanly from the new position.
    // Combined with ABR switches, keeping stale data here would cause the walk
    // to skip segments that have been evicted and never re-fetch them.
    const SEEK_THRESHOLD_S = 1.0;
    if (
      this.#lastCurrentTime >= 0 &&
      Math.abs(currentTime - this.#lastCurrentTime) > SEEK_THRESHOLD_S &&
      bufferedAhead(currentTime, sbBuffered) < 0.1
    ) {
      trace(this, 'timeline', 'seek-reset', {
        from:  +this.#lastCurrentTime.toFixed(3),
        to:    +currentTime.toFixed(3),
        delta: +(currentTime - this.#lastCurrentTime).toFixed(3),
      });
      this.#fetchedSegments.clear();
      this.#timelineDrift = 0;
    }
    this.#lastCurrentTime = currentTime;
    // ── end seek detection ────────────────────────────────────────────────

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

    // Find the segment whose effective time range covers currentTime.
    // "Effective" start = declared startTime + cumulative timeline drift.
    // Using drift-adjusted times ensures the walk stays aligned after appends
    // produce slightly different durations than the manifest declared.
    let startIdx = segs.findIndex((s: any) => {
      const eff = (s.startTime as number) + this.#timelineDrift;
      return eff <= currentTime + 0.1 && currentTime < eff + (s.duration as number);
    });
    if (startIdx < 0) {
      // currentTime is before the first segment or the timeline hasn't shifted
      // enough — start from segment 0 if we haven't passed it, else give up.
      const firstEff = ((segs[0] as any).startTime as number) + this.#timelineDrift;
      startIdx = currentTime + 0.1 < firstEff ? 0 : -1;
    }
    if (startIdx < 0) return;

    // Walk forward from startIdx, skipping segments that are already handled.
    // A segment is handled if:
    //   (a) it is in #fetchedSegments — dispatched in the current session, OR
    //   (b) isBuffered confirms its content is in the SourceBuffer with the
    //       generous tolerance that accounts for encoder drift.
    // Using both prevents the stuck-segment bug (a) and avoids re-fetching
    // content that arrived from a prior session or ABR switch (b).
    let targetIdx = startIdx;
    while (targetIdx < segs.length) {
      const s: any = segs[targetIdx];
      const eff    = (s.startTime as number) + this.#timelineDrift;
      if (
        !this.#fetchedSegments.has(segs[targetIdx]) &&
        !isBuffered(eff, s.duration as number, sbBuffered)
      ) {
        break; // Found the next segment that needs fetching.
      }
      targetIdx++;
    }
    if (targetIdx >= segs.length) return;

    // Find the first un-handled segment AFTER target for prefetching.
    let nextIdx = targetIdx + 1;
    while (nextIdx < segs.length) {
      const s: any = segs[nextIdx];
      const eff    = (s.startTime as number) + this.#timelineDrift;
      if (
        !this.#fetchedSegments.has(segs[nextIdx]) &&
        !isBuffered(eff, s.duration as number, sbBuffered)
      ) {
        break;
      }
      nextIdx++;
    }

    const target = segs[targetIdx];
    if (target.getAttribute('videl-state') !== 'active') {
      trace(this, 'pump', 'segment-activate', {
        startTime:      (target as any).startTime,
        effectiveStart: +((target as any).startTime + this.#timelineDrift).toFixed(3),
        duration:       (target as any).duration,
        url:            (target as any).url,
        drift:          +this.#timelineDrift.toFixed(3),
      });
      target.sourceBuffer = this.#sourceBuffer;
      this.activateChild(target);
      // NOTE: do NOT add target to #fetchedSegments here. The segment is only
      // considered "done" once its bytes have been appended and videl:done fires
      // (handled in #onSegmentDone). Adding it here would cause the walk to skip
      // this segment on the very next tick and try to activate the next one — which
      // would call PickOneMixin.activateChild on the next segment, removing
      // videl-state from this still-in-flight segment and aborting its fetch.
    }

    if (nextIdx < segs.length) {
      const next = segs[nextIdx];
      if (next.getAttribute('videl-state') !== 'next') {
        next.sourceBuffer = this.#sourceBuffer;
        this.preloadChild(next);
        // NOTE: do NOT add next to #fetchedSegments. Preloading starts the fetch
        // but the bytes are not in the SourceBuffer yet. If added here, the walk
        // would skip this segment (treating it as appended) and jump ahead by two
        // positions on every tick — appending only every other segment.
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
    if (!this.initializationUrl) {
      // Self-initializing representation (ISO on-demand profile): the single
      // whole-file segment carries its own moov, so there is no separate init
      // segment to fetch. Mark init complete so the pump appends it directly.
      if (this.#childSegments.length > 0) this.#initAppended = true;
      return;
    }

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

  /**
   * Listen for `videl:done` from direct `<videl-segment>` children.
   * After each successful append, compare the actual SourceBuffer end to the
   * segment's declared end and update `#timelineDrift` so that subsequent
   * segment selections use the correct effective start positions.
   *
   * This handles drift in both directions:
   *   Negative drift — segment buffered less than declared (most common).
   *   Positive drift — segment buffered more than declared.
   */
  #onSegmentDone = (event: Event): void => {
    const target = event.target as Element;
    const self   = this as unknown as HTMLElement;
    if (target.parentElement !== self) return;
    if (target.tagName.toLowerCase() !== 'videl-segment') return;
    if (!this.#sourceBuffer) return;

    const seg          = target as any;
    const sbBuffered   = this.#sourceBuffer.buffered;

    // The segment's bytes are now in the SourceBuffer — mark it as fetched.
    // This is the only correct place to do so: earlier (at activateChild or
    // preloadChild time) the data isn't in the buffer yet, which would cause
    // the walk to skip segments prematurely and break sequential appending.
    this.#fetchedSegments.add(target);

    // Locate the actual end of the buffer at this segment's effective position.
    const effectiveStart = (seg.startTime as number) + this.#timelineDrift;
    const actualEnd      = bufferEndNear(effectiveStart, sbBuffered);
    if (actualEnd === null) return; // Buffer state unclear — skip drift update.

    // Declared end in MPD time (un-adjusted — segments keep their original times).
    const declaredEnd = (seg.startTime as number) + (seg.duration as number);
    const prevDrift   = this.#timelineDrift;

    // New cumulative drift: how far the real buffer end is from the declared end.
    this.#timelineDrift = actualEnd - declaredEnd;

    const delta = this.#timelineDrift - prevDrift;
    if (Math.abs(delta) > 0.001) {
      trace(this, 'timeline', 'drift-update', {
        segmentStart: seg.startTime,
        declaredEnd:  +declaredEnd.toFixed(4),
        actualEnd:    +actualEnd.toFixed(4),
        drift:        +this.#timelineDrift.toFixed(4),
        delta:        +delta.toFixed(4),
      });
    }
  };

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    const active = this.getAttribute('videl-state') === 'active';
    const kbps   = this.bandwidth ? Math.round(this.bandwidth / 1000) : 0;
    const dims   = this.width && this.height ? `${this.width}×${this.height}` : '';
    // Primary label prefers resolution; bandwidth is the secondary detail.
    const primary   = dims || (kbps ? `${kbps} kbps` : (this.repId || 'rep'));
    const secondary = dims && kbps ? `${kbps} kbps` : '';

    return html`
      <style>
        :host { display: block; box-sizing: border-box; }
        .q {
          padding: 6px 8px;
          margin: 1px 0;
          color: #ddd;
          font-family: ui-monospace, monospace;
          font-size: 12px;
          display: flex;
          justify-content: space-between;
          gap: 10px;
          cursor: default;
        }
        :host([videl-state="active"]) .q {
          background: rgba(79, 156, 249, 0.25);
          color: #fff;
        }
        .q .detail { color: #9ab; }
        ::slotted(videl-segment) { display: none !important; }
      </style>

      <div class="q">
        <span>${primary}${active ? ' ✓' : ''}</span>
        <span class="detail">${secondary}</span>
      </div>
      <slot></slot>

      ${this.debug ? html`
        <div style="font-family:monospace;font-size:11px;border:1px solid #88a;padding:4px;margin-top:4px;background:rgba(0,0,0,0.6);color:#fff">
          <strong>videl-representation</strong>
          id=<em>${this.repId}</em>
          bw=<em>${this.bandwidth}</em>
          state=<em>${this.getAttribute('videl-state') ?? 'idle'}</em>
          init=<em>${this.#initAppended ? 'done' : 'pending'}</em>
          drift=<em>${this.#timelineDrift.toFixed(3)}s</em>
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('videl-representation', VidelRepresentation);
