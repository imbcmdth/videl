import { LitElement, html, nothing } from 'lit';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import type { PlayerState } from '../player-state';
import type { ISourceBuffer } from '../lib/ergo-mse';
import { parseSidx } from '../lib/mp4';
import { expandTemplate, resolveUrl } from '../parser/template-utils';
import { VidelSegment } from './videl-segment';
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
    repId: { type: String,  attribute: 'id' },
    bandwidth: { type: Number },
    width: { type: Number },
    height: { type: Number },
    codecs: { type: String },
    mimeType: { type: String,  attribute: 'mime-type' },
    initializationUrl: { type: String,  attribute: 'initialization-url' },
    initializationByteRange: { type: String,  attribute: 'initialization-byte-range' },
    /**
     * Presentation-time offset stamped by the MPD parser:
     *   timestampOffset = periodStart − presentationTimeOffset / timescale
     * Applied to SourceBuffer.timestampOffset after the init segment is appended
     * to align the media decode timeline with the MSE presentation timeline.
     * Absent (default 0) when @presentationTimeOffset is zero or not specified.
     */
    timestampOffset: { type: Number,  attribute: 'timestamp-offset' },

    // ── SegmentTemplate addressing (stamped by parser, expanded at activation) ──
    /** Pre-expanded (id/bandwidth) + base-resolved media URL template.
     *  $Number$ and $Time$ tokens remain for expansion per-segment. */
    segmentTemplateMedia:       { type: String,  attribute: 'segment-template-media' },
    segmentTemplateTimescale:   { type: Number,  attribute: 'segment-template-timescale' },
    segmentTemplateStartNumber: { type: Number,  attribute: 'segment-template-start-number' },
    segmentTemplatePto:         { type: Number,  attribute: 'segment-template-pto' },
    /** Fixed segment duration in timescale ticks (@duration, no SegmentTimeline). */
    segmentTemplateDuration:    { type: Number,  attribute: 'segment-template-duration' },
    /** JSON-serialised [{t?,d,r}] from SegmentTimeline <S> elements. */
    segmentTemplateTimeline:    { type: String,  attribute: 'segment-template-timeline' },

    // ── SegmentBase addressing (stamped by parser, resolved at activation) ──
    /** Resolved base URL for the media file (SegmentBase or ISO on-demand). */
    segmentBaseUrl:        { type: String,  attribute: 'segment-base-url' },
    /** indexRange from SegmentBase/@indexRange — if present, a sidx fetch is required. */
    segmentBaseIndexRange: { type: String,  attribute: 'segment-base-index-range' },
    /** ISO on-demand: period duration stamped for the whole-file single segment. */
    periodDuration:        { type: Number,  attribute: 'period-duration' },

    /** Present when MPD@type="dynamic" — suppresses isFullyFetched, enables live extension. */
    live: { type: Boolean },
    /** DVR window depth in seconds from MPD@timeShiftBufferDepth. */
    timeShiftBufferDepth:  { type: Number,  attribute: 'time-shift-buffer-depth' },

    slot: { type: String,  reflect: true },
    /** Set by the parent adaptation-set when this rep is manually pinned. */
    pinned: { type: Boolean, attribute: 'videl-pinned' },
    debug: { type: Boolean }
  };

  repId                    = '';
  bandwidth                = 0;
  width                    = 0;
  height                   = 0;
  codecs                   = '';
  mimeType                 = '';
  initializationUrl        = '';
  initializationByteRange: string | null = null;
  timestampOffset          = 0;

  // SegmentTemplate
  segmentTemplateMedia       = '';
  segmentTemplateTimescale   = 1;
  segmentTemplateStartNumber = 1;
  segmentTemplatePto         = 0;
  segmentTemplateDuration    = 0;
  segmentTemplateTimeline    = '';

  // SegmentBase / ISO on-demand
  segmentBaseUrl        = '';
  segmentBaseIndexRange = '';
  periodDuration        = 0;

  live                  = false;
  timeShiftBufferDepth  = 0;
  slot   = '';
  pinned = false;
  debug  = false;

  // ── SourceBuffer ──────────────────────────────────────────────────────────

  #sourceBuffer: ISourceBuffer | null = null;

  get sourceBuffer(): ISourceBuffer | null {
    return this.#sourceBuffer;
  }

  set sourceBuffer(val: ISourceBuffer | null) {
    if (val === this.#sourceBuffer) {
      return;
    }
    this.#initController?.abort();
    this.#initController = null;
    this.#initPromise    = null;
    this.removeAttribute('videl-init-appended');
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

    if (name !== 'videl-state') {
      return;
    }

    if (value === 'next' || value === 'active') {
      // For live streams, compute the timestamp offset exactly once — before
      // #startInit so the computed value is applied when the init append
      // completes and sourceBuffer.timestampOffset is set.
      if (this.live && !this.hasAttribute('videl-init-appended')) {
        this.#computeLiveTimestampOffset();
      }
      // Populate segments first (sync for SegmentTemplate/SegmentBase-no-sidx,
      // async for sidx).  #startInit follows immediately — for sidx streams
      // the init fetch and sidx fetch run concurrently; the pump's
      // #initAppended gate prevents segment walks until both complete.
      this.#populateSegments();
      this.#startInit();
    } else if (value === null) {
      this.#initController?.abort();
      this.#initController = null;
      this.#initPromise    = null;
      // Reset so the init segment is always re-sent on the next activation.
      this.removeAttribute('videl-init-appended');
      // Clear fetch history, drift, and position tracking — fresh activation.
      this.#fetchedSegments.clear();
      this.#timelineDrift   = 0;
      this.#lastCurrentTime = -1;
    }
  }

  // ── Pump method ───────────────────────────────────────────────────────────

  videlUpdate(state: PlayerState): void {
    if (!this.hasAttribute('videl-init-appended')) {
      return;
    }
    if (this.getAttribute('videl-state') !== 'active') {
      return;
    }
    if (!this.#sourceBuffer) {
      return;
    }

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
        from: +this.#lastCurrentTime.toFixed(3),
        to: +currentTime.toFixed(3),
        delta: +(currentTime - this.#lastCurrentTime).toFixed(3)
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
        bufferAhead
      });
      return;
    }

    // For live representations, extend the segment list before the walk so that
    // newly available segments exist for the pump to act on this tick.  This
    // must happen before the segs.length === 0 guard — for live that guard
    // would always fire on the first tick (no segments yet) and prevent the
    // extension from ever running.
    this.#extendLiveSegments();

    const segs = this.#childSegments;
    if (segs.length === 0) {
      return;
    }

    // Find the segment whose effective time range covers currentTime.
    // "Effective" start = declared startTime + cumulative timeline drift.
    // Using drift-adjusted times ensures the walk stays aligned after appends
    // produce slightly different durations than the manifest declared.
    let startIdx = segs.findIndex((s) => {
      const eff = s.startTime + this.#timelineDrift;
      return eff <= currentTime + 0.1 && currentTime < eff + s.duration;
    });
    if (startIdx < 0) {
      // currentTime is before the first segment or the timeline hasn't shifted
      // enough — start from segment 0 if we haven't passed it, else give up.
      const firstEff = (segs[0]?.startTime ?? 0) + this.#timelineDrift;
      startIdx = currentTime + 0.1 < firstEff ? 0 : -1;
    }
    if (startIdx < 0) {
      return;
    }

    // Walk forward from startIdx, skipping segments that are already handled.
    // A segment is handled if:
    //   (a) it is in #fetchedSegments — dispatched in the current session, OR
    //   (b) isBuffered confirms its content is in the SourceBuffer with the
    //       generous tolerance that accounts for encoder drift.
    // Using both prevents the stuck-segment bug (a) and avoids re-fetching
    // content that arrived from a prior session or ABR switch (b).
    let targetIdx = startIdx;
    while (targetIdx < segs.length) {
      const s   = segs[targetIdx]!;
      const eff = s.startTime + this.#timelineDrift;
      if (
        !this.#fetchedSegments.has(segs[targetIdx]!) &&
        !isBuffered(eff, s.duration, sbBuffered)
      ) {
        break; // Found the next segment that needs fetching.
      }
      targetIdx++;
    }
    if (targetIdx >= segs.length) {
      return;
    }

    // Find the first un-handled segment AFTER target for prefetching.
    let nextIdx = targetIdx + 1;
    while (nextIdx < segs.length) {
      const s   = segs[nextIdx]!;
      const eff = s.startTime + this.#timelineDrift;
      if (
        !this.#fetchedSegments.has(segs[nextIdx]!) &&
        !isBuffered(eff, s.duration, sbBuffered)
      ) {
        break;
      }
      nextIdx++;
    }

    const target = segs[targetIdx];
    if (target.getAttribute('videl-state') !== 'active') {
      trace(this, 'pump', 'segment-activate', {
        startTime: target.startTime,
        effectiveStart: +(target.startTime + this.#timelineDrift).toFixed(3),
        duration: target.duration,
        url: target.url,
        drift: +this.#timelineDrift.toFixed(3)
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

  get #childSegments(): VidelSegment[] {
    return Array.from(this.children).filter(el => el.tagName.toLowerCase() === 'videl-segment') as VidelSegment[];
  }

  /**
   * True once the **last** segment has been appended to the SourceBuffer.
   * Checking only the last segment (not all of them) is seek-correct: after a
   * seek the representation skips earlier segments and walks forward from the
   * new position, so `#fetchedSegments` will never contain the skipped ones.
   * What matters for seamless period transitions is that the segment adjacent
   * to the next period boundary has been buffered — i.e. the last one.
   *
   * Always returns `false` for live representations — there is no stable
   * "last" segment in a live stream, so the period must never signal done.
   */
  get isFullyFetched(): boolean {
    if (this.live) {
      return false;
    }
    const segs    = this.#childSegments;
    const lastSeg = segs[segs.length - 1];
    return lastSeg !== undefined && this.#fetchedSegments.has(lastSeg);
  }

  // ── User interaction ──────────────────────────────────────────────────────

  /**
   * Left-click: pin this representation, disabling ABR.
   * The parent adaptation-set catches `videl:rep:select`.
   */
  #onClick = (): void => {
    this.dispatchEvent(new CustomEvent('videl:rep:select', {
      bubbles: true,
      composed: true,
      detail: { rep: this }
    }));
  };

  /**
   * Right-click: remove this representation from the available pool.
   * preventDefault suppresses the browser context menu.
   * The parent adaptation-set catches `videl:rep:remove`.
   */
  #onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    this.dispatchEvent(new CustomEvent('videl:rep:remove', {
      bubbles: true,
      composed: true,
      detail: { rep: this }
    }));
  };

  // ── Live timestamp offset ─────────────────────────────────────────────────

  /**
   * Compute and stamp the `timestamp-offset` for live (type="dynamic") streams.
   *
   * For live DASH the fMP4 decode timestamps are wall-clock-based (e.g.
   * epoch-seconds when availabilityStartTime="1970-01-01T00:00:00Z").
   * Without correction, video.currentTime would reflect those raw timestamps
   * (potentially billions of seconds).
   *
   * We want:
   *   currentTime = 0  → DVR window start (wall clock = now − TSBD)
   *   currentTime = TSBD → live edge at activation time
   *
   * Derivation:
   *   media decode time of DVR start = (now − TSBD) − availStart
   *   timestamp-offset = −(media time of DVR start)
   *                    = availStart + TSBD − now
   *
   * The live edge currentTime then grows at 1:1 wall-clock rate:
   *   liveEdge = (wallClock − availStart) + timestampOffset
   *            = wallClock − availStart + availStart + TSBD − activationNow
   *            = TSBD + (wallClock − activationNow)
   *
   * Called once on first activation (before #startInit), so #startInit
   * applies the correct value to SourceBuffer.timestampOffset when the init
   * segment is appended.
   */
  #computeLiveTimestampOffset(): void {
    const availStr = this.getAttribute('availability-start-time');
    const tsbdStr  = this.getAttribute('time-shift-buffer-depth');
    if (!availStr) {
      return;
    }
    const availStart = Number(availStr);
    const tsbd       = tsbdStr ? Number(tsbdStr) : 30;
    const nowSec     = Date.now() / 1000;
    const liveOffset = availStart + tsbd - nowSec;
    // Stamp on DOM (DOM-first principle) — Lit syncs attribute → property.
    this.setAttribute('timestamp-offset', String(liveOffset));
  }

  // ── Segment population ────────────────────────────────────────────────────

  /**
   * Populate `<videl-segment>` children from the addressing attributes stamped
   * by the MPD parser.  Called once when `videl-state` first becomes "next" or
   * "active".  No-op if children are already present (e.g. re-activation after
   * a "next"→"active" transition or SegmentList representations whose segments
   * were created by the parser).
   */
  #populateSegments(): void {
    if (this.#childSegments.length > 0) {
      return;
    }

    if (this.segmentTemplateMedia) {
      this.#buildFromTemplate();
      return;
    }

    if (this.segmentBaseUrl) {
      if (this.segmentBaseIndexRange) {
        // Async — sidx fetch runs concurrently with the init segment fetch.
        void this.#fetchAndParseSidx();
      } else {
        this.#buildFromSegmentBase();
      }
      return;
    }
    // SegmentList representations already have children from the parser — no-op.
  }

  /**
   * Build `<videl-segment>` children from `segment-template-*` attributes.
   * Mirrors the parser's former `buildFromTimeline` / `buildFromNumber` logic,
   * now running at activation time with per-representation context.
   */
  #buildFromTemplate(): void {
    const media      = this.segmentTemplateMedia;
    // Use ?? rather than || so that valid falsy values (startNumber=0, pto=0) are preserved.
    const timescale  = this.segmentTemplateTimescale  ?? 1;
    const startNum   = this.segmentTemplateStartNumber ?? 1;
    const pto        = this.segmentTemplatePto         ?? 0;

    // Period context from the nearest ancestor <videl-period>.
    const periodEl       = this.closest('videl-period');
    const periodStart    = Number(periodEl?.getAttribute('start')    ?? 0);
    const periodDurStr   = periodEl?.getAttribute('duration');
    const periodDuration = periodDurStr ? Number(periodDurStr) : undefined;

    if (this.segmentTemplateTimeline) {
      // SegmentTimeline path — uses $Number$ and/or $Time$.
      let entries: Array<{ d: number; r: number; t?: number }>;
      try {
        entries = JSON.parse(this.segmentTemplateTimeline) as typeof entries;
      } catch {
        return;
      }

      let segNumber = startNum;
      let t         = 0;

      for (const entry of entries) {
        const sT = entry.t !== undefined ? entry.t : t;
        const d  = entry.d;
        if (d === 0) {
          continue;
        }
        let r = entry.r;
        t = sT;

        if (r === -1) {
          if (periodDuration !== undefined) {
            const periodEndTicks = periodDuration * timescale + pto;
            r = Math.max(0, Math.ceil((periodEndTicks - t) / d) - 1);
          } else {
            r = 0;
          }
        }

        for (let i = 0; i <= r; i++) {
          const url       = expandTemplate(media, { number: segNumber, time: t });
          const startTime = periodStart + (t - pto) / timescale;
          const duration  = d / timescale;
          this.#appendSegmentEl(url, startTime, duration);
          t += d;
          segNumber++;
        }
      }
    } else if (this.segmentTemplateDuration) {
      // @duration path — uses $Number$ only.
      const segDurSec = this.segmentTemplateDuration / timescale;
      if (periodDuration === undefined || segDurSec <= 0) {
        return;
      }
      const count = Math.ceil(periodDuration / segDurSec);
      for (let i = 0; i < count; i++) {
        const segNumber = startNum + i;
        const url       = expandTemplate(media, { number: segNumber });
        const startTime = periodStart + i * segDurSec;
        this.#appendSegmentEl(url, startTime, segDurSec);
      }
    }
  }

  /**
   * Build a single `<videl-segment>` for a SegmentBase representation that has
   * no sidx index (or the ISO on-demand whole-file profile).
   */
  #buildFromSegmentBase(): void {
    const url      = this.segmentBaseUrl;
    const periodEl = this.closest('videl-period');
    const start    = Number(periodEl?.getAttribute('start') ?? 0);
    const dur      = this.periodDuration || Number(periodEl?.getAttribute('duration') ?? 0);
    this.#appendSegmentEl(url, start, dur);
  }

  /**
   * Fetch the sidx box at `segment-base-index-range`, parse it, and create
   * one `<videl-segment>` per media entry.  Runs concurrently with the init
   * segment fetch — the pump's `#initAppended` gate ensures no segment walks
   * occur until both are ready.
   */
  async #fetchAndParseSidx(): Promise<void> {
    const url        = this.segmentBaseUrl;
    const rangeAttr  = this.segmentBaseIndexRange;
    const [startStr, endStr] = rangeAttr.split('-');
    const rangeStart = Number(startStr);
    const rangeEnd   = Number(endStr);

    if (isNaN(rangeStart) || isNaN(rangeEnd) || rangeEnd < rangeStart) {
      this.dispatchEvent(new CustomEvent('videl:segment:error', {
        bubbles: true, composed: true,
        detail: { error: new Error(`[videl] sidx: invalid indexRange "${rangeAttr}"`) }
      }));
      return;
    }

    let buffer: ArrayBuffer;
    try {
      const resp = await fetch(url, {
        headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
        signal: this.#initController?.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching sidx at ${url} range ${rangeAttr}`);
      }
      buffer = await resp.arrayBuffer();
    } catch (err: unknown) {
      if (this.getAttribute('videl-state') === null) {
        return;
      } // Aborted on deactivation — not an error.
      this.dispatchEvent(new CustomEvent('videl:segment:error', {
        bubbles: true, composed: true,
        detail: { error: err instanceof Error ? err : new Error(String(err)) }
      }));
      return;
    }

    const sidxEndByte = rangeEnd + 1;
    const entries     = parseSidx(buffer, sidxEndByte);

    if (entries.length === 0) {
      this.dispatchEvent(new CustomEvent('videl:segment:error', {
        bubbles: true, composed: true,
        detail: { error: new Error(`[videl] sidx: parsed 0 entries from ${url} range ${rangeAttr}`) }
      }));
      return;
    }

    for (const entry of entries) {
      const seg = document.createElement('videl-segment') as VidelSegment;
      seg.setAttribute('url',        url);
      seg.setAttribute('byte-range', entry.byteRange);
      seg.setAttribute('start-time', String(entry.startTime));
      seg.setAttribute('duration',   String(entry.duration));
      this.appendChild(seg);
    }

    trace(this, 'fetch', 'sidx-parsed', {
      url,
      entryCount:       entries.length,
      firstStartTime:   entries[0]!.startTime,
      totalDuration:    entries.reduce((s, e) => s + e.duration, 0),
    });
  }

  /**
   * Extend the segment list for live (type="dynamic") SegmentTemplate streams.
   *
   * Called on every videlUpdate() tick.  For VOD representations this is a
   * no-op.  For live, computes which segment numbers are available based on
   * wall clock time and appends any that are not yet in the child list.
   *
   * Segment availability:
   *   currentSegNum  = floor((nowSec - availabilityStartTime) / segDurSec) - 1
   *   (−1 margin: the encoder may not have finished the very latest segment)
   *
   * Bootstrap (no segments yet): generate the full DVR window worth of
   * segments so the pump can seek within the available range.
   *
   * Extend (segments already exist): append only newly published segments
   * beyond the last known one, derived from the last segment's start-time.
   */
  #extendLiveSegments(): void {
    if (!this.live) {
      return;
    }
    const availStr = this.getAttribute('availability-start-time');
    if (!availStr) {
      return;
    }
    const media = this.segmentTemplateMedia;
    if (!media) {
      return;
    }
    const segDuration = this.segmentTemplateDuration;
    if (!segDuration) {
      return; // SegmentTimeline live — deferred
    }

    const availabilityStartTime = Number(availStr);
    const timescale  = this.segmentTemplateTimescale  ?? 1;
    const startNum   = this.segmentTemplateStartNumber ?? 1;
    const segDurSec  = segDuration / timescale;
    const nowSec     = Date.now() / 1000;

    // Latest segment number available (with one-segment safety margin for encoder lag).
    const latestSegNum = Math.floor((nowSec - availabilityStartTime) / segDurSec) - 1;

    const periodEl    = this.closest('videl-period');
    const periodStart = Number(periodEl?.getAttribute('start') ?? 0);
    const segs        = this.#childSegments;

    let fromSegNum: number;

    if (segs.length === 0) {
      // Bootstrap: start from the DVR window boundary (or startNumber if newer).
      const tsbd = this.timeShiftBufferDepth > 0 ? this.timeShiftBufferDepth : 30;
      const dvrStartSec = nowSec - tsbd;
      fromSegNum = Math.max(
        startNum,
        Math.floor((dvrStartSec - availabilityStartTime) / segDurSec)
      );
    } else {
      // Extend: derive the last segment number from its start-time attribute,
      // then append any newly published segments after it.
      const lastSeg        = segs[segs.length - 1]!;
      const lastRelSec     = lastSeg.startTime - periodStart;
      const lastSegNum     = startNum + Math.round(lastRelSec / segDurSec);
      fromSegNum = lastSegNum + 1;
    }

    if (fromSegNum > latestSegNum) {
      return; // Nothing new yet.
    }

    for (let n = fromSegNum; n <= latestSegNum; n++) {
      const i     = n - startNum;
      const url   = expandTemplate(media, { number: n });
      const sTime = periodStart + i * segDurSec;
      this.#appendSegmentEl(url, sTime, segDurSec);
    }

    trace(this, 'fetch', 'live-segments-extended', {
      from:   fromSegNum,
      to:     latestSegNum,
      count:  latestSegNum - fromSegNum + 1,
    });
  }

  /** Create and append a `<videl-segment>` child with the given properties. */
  #appendSegmentEl(url: string, startTime: number, duration: number): void {
    const seg = document.createElement('videl-segment') as VidelSegment;
    seg.setAttribute('url',        url);
    seg.setAttribute('start-time', String(startTime));
    seg.setAttribute('duration',   String(duration));
    this.appendChild(seg);
  }

  #startInit(): void {
    if (this.hasAttribute('videl-init-appended')) {
      return;
    }
    if (this.#initPromise)  {
      return;
    }
    if (!this.#sourceBuffer) {
      return;
    }
    if (!this.initializationUrl) {
      // Self-initializing representation (ISO on-demand profile): the single
      // whole-file segment carries its own moov, so there is no separate init
      // segment to fetch. Mark init complete so the pump appends it directly.
      if (this.#childSegments.length > 0) {
        this.setAttribute('videl-init-appended', '');
      }
      return;
    }

    trace(this, 'fetch', 'init-fetch-start', { url: this.initializationUrl });
    this.#initController = new AbortController();
    this.#initPromise = this.#doFetchInit(this.#initController.signal)
      .then(() => {
        this.setAttribute('videl-init-appended', '');
        trace(this, 'buffer', 'init-append-complete', { url: this.initializationUrl });
        // Apply presentation-time offset so the SourceBuffer (real or fake)
        // maps media decode times to the correct MSE timeline position.
        if (this.#sourceBuffer && this.timestampOffset !== 0) {
          this.#sourceBuffer.timestampOffset = this.timestampOffset;
        }
      })
      .catch((err: unknown) => {
        if (this.getAttribute('videl-state') === null) {
          return;
        }
        this.dispatchEvent(new CustomEvent('videl:segment:error', {
          bubbles: true,
          composed: true,
          detail: { error: err instanceof Error ? err : new Error(String(err)) }
        }));
      })
      .finally(() => {
        this.#initPromise = null;
      });
  }

  async #doFetchInit(signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.initializationByteRange) {
      headers.Range = `bytes=${this.initializationByteRange}`;
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
    if (!(event.target instanceof VidelSegment)) {
      return;
    }
    const self = this as unknown as HTMLElement;
    if (event.target.parentElement !== self) {
      return;
    }
    if (!this.#sourceBuffer) {
      return;
    }

    const seg = event.target;
    const sbBuffered = this.#sourceBuffer.buffered;

    // The segment's bytes are now in the SourceBuffer — mark it as fetched.
    // This is the only correct place to do so: earlier (at activateChild or
    // preloadChild time) the data isn't in the buffer yet, which would cause
    // the walk to skip segments prematurely and break sequential appending.
    this.#fetchedSegments.add(seg);

    // Locate the actual end of the buffer at this segment's effective position.
    const effectiveStart = seg.startTime + this.#timelineDrift;
    const actualEnd      = bufferEndNear(effectiveStart, sbBuffered);
    if (actualEnd === null) {
      return;
    } // Buffer state unclear — skip drift update.

    // Declared end in MPD time (un-adjusted — segments keep their original times).
    const declaredEnd = seg.startTime + seg.duration;
    const prevDrift   = this.#timelineDrift;

    // New cumulative drift: how far the real buffer end is from the declared end.
    this.#timelineDrift = actualEnd - declaredEnd;

    const delta = this.#timelineDrift - prevDrift;
    if (Math.abs(delta) > 0.001) {
      trace(this, 'timeline', 'drift-update', {
        segmentStart: seg.startTime,
        declaredEnd: +declaredEnd.toFixed(4),
        actualEnd: +actualEnd.toFixed(4),
        drift: +this.#timelineDrift.toFixed(4),
        delta: +delta.toFixed(4)
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
          cursor: pointer;
          user-select: none;
        }
        :host([videl-state="active"]) .q {
          background: rgba(79, 156, 249, 0.25);
          color: #fff;
        }
        /* Pinned (ABR disabled, this rep is forced): accent left border. */
        :host([videl-pinned]) .q {
          border-left: 2px solid #4f9cf9;
          padding-left: 6px;
        }
        .q .detail { color: #9ab; }
        ::slotted(videl-segment) { display: none !important; }
      </style>

      <div class="q" @click=${this.#onClick} @contextmenu=${this.#onContextMenu}>
        <span>${primary}${active ? ' ✓' : ''}${this.pinned ? ' ⚲' : ''}</span>
        <span class="detail">${secondary}</span>
      </div>
      <slot></slot>

      ${this.debug ? html`
        <div style="font-family:monospace;font-size:11px;border:1px solid #88a;padding:4px;margin-top:4px;background:rgba(0,0,0,0.6);color:#fff">
          <strong>videl-representation</strong>
          id=<em>${this.repId}</em>
          bw=<em>${this.bandwidth}</em>
          state=<em>${this.getAttribute('videl-state') ?? 'idle'}</em>
          init=<em>${this.hasAttribute('videl-init-appended') ? 'done' : 'pending'}</em>
          drift=<em>${this.#timelineDrift.toFixed(3)}s</em>
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('videl-representation', VidelRepresentation);
