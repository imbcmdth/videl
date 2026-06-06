/**
 * TextSourceBuffer — a fake SourceBuffer that implements ISourceBuffer and
 * routes text-track fMP4 segments through the demuxer + payload parsers,
 * injecting VTTCue objects into a TextTrack owned by the video element.
 *
 * All SourceBuffer-like semantics are preserved:
 *   - Serialized async operation queue (one append/remove in flight at a time)
 *   - `buffered` TimeRanges via SyntheticTimeRanges
 *   - `remove(start, end)` removes cues in the range and trims buffered
 *   - Replace-on-append: cues in the incoming segment's time range are
 *     removed before new cues are inserted
 *   - `timestampOffset` shifts all decoded PTS values to presentation time
 *   - `abort()` flushes the queue
 *   - `changeType()` updates the codec hint and resets the demuxer
 *   - `show()` / `hide()` control TextTrack.mode
 *
 * The TextTrack is created in 'hidden' mode. The "None" adaptation set
 * activates first by default, calling `hide()` on activation, confirming
 * the hidden state. A user selecting a language track calls `show()`.
 */

import type { ISourceBuffer } from './i-source-buffer';
import { SyntheticTimeRanges } from './synthetic-time-ranges';
import { Fmp4TextDemuxer } from './fmp4-text-demuxer';
import { classifyTextMimeAndCodecs } from './text-codec';
import { findBox } from './fmp4-box-utils';
import type { TextCodecClass } from './text-codec';
import { parseWvttSample } from './wvtt-parser';
import { parseStppSample } from './stpp-parser';

// ── VTT settings → VTTCue properties ──────────────────────────────────────────

/**
 * Apply a WebVTT cue settings string to a VTTCue.
 * Only a subset is applied (line, position, align, size) — the rest are
 * silently ignored. This is best-effort for V1.
 */
function applyCueSettings(cue: VTTCue, settings: string): void {
  if (!settings.trim()) return;
  for (const token of settings.trim().split(/\s+/)) {
    const [key, val] = token.split(':');
    if (!key || !val) continue;
    switch (key.toLowerCase()) {
      case 'line': {
        const n = parseFloat(val);
        if (!isNaN(n)) cue.line = n;
        break;
      }
      case 'position': {
        const n = parseFloat(val);
        if (!isNaN(n)) cue.position = n;
        break;
      }
      case 'size': {
        const n = parseFloat(val);
        if (!isNaN(n)) cue.size = n;
        break;
      }
      case 'align': {
        const v = val.toLowerCase() as AlignSetting;
        if (['start','center','end','left','right'].includes(v)) cue.align = v;
        break;
      }
    }
  }
}

// ── TextSourceBuffer ──────────────────────────────────────────────────────────

interface QueueEntry {
  kind:    'append' | 'remove' | 'abort';
  args:    any[];
  resolve: () => void;
  reject:  (err: Error) => void;
}

export class TextSourceBuffer implements ISourceBuffer {
  // ── TextTrack (public — consumers can set .mode directly) ─────────────────
  readonly textTrack: TextTrack;

  // ── ISourceBuffer state ───────────────────────────────────────────────────
  timestampOffset = 0;

  #updating       = false;
  #bufferedRanges = new SyntheticTimeRanges();

  // ── Demuxer + codec ───────────────────────────────────────────────────────
  #demuxer       = new Fmp4TextDemuxer();
  #codecClass:   TextCodecClass = { kind: 'unknown' };
  #warnedImage   = false;
  #warnedUnknown = false;

  // ── Operation queue ───────────────────────────────────────────────────────
  #queue:        QueueEntry[] = [];
  #isProcessing  = false;

  // ── Constructor ───────────────────────────────────────────────────────────

  /**
   * @param videoEl    The HTMLVideoElement that will own the TextTrack.
   * @param label      Display label shown in the browser's track selector.
   * @param lang       BCP-47 language tag (e.g. "en", "fr").
   * @param codecHint  Codec string from the MPD manifest (e.g. "stpp.ttml.im1t").
   *                   Used to classify image-profile codecs and route samples
   *                   to the correct parser.
   */
  constructor(
    videoEl:   HTMLVideoElement,
    label:     string,
    lang:      string,
    codecHint: string = '',
  ) {
    this.textTrack           = videoEl.addTextTrack('subtitles', label, lang);
    this.textTrack.mode      = 'hidden';
    this.#codecClass         = classifyTextMimeAndCodecs(codecHint);
  }

  // ── ISourceBuffer ─────────────────────────────────────────────────────────

  get updating(): boolean { return this.#updating; }

  get buffered(): TimeRanges {
    return this.#bufferedRanges as unknown as TimeRanges;
  }

  async append(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ kind: 'append', args: [data], resolve, reject });
      this.#pump();
    });
  }

  async remove(start: number, end: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ kind: 'remove', args: [start, end], resolve, reject });
      this.#pump();
    });
  }

  async abort(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Reject all queued-but-not-started operations immediately.
      const startIdx = this.#isProcessing ? 1 : 0;
      const drained  = this.#queue.splice(startIdx);
      for (const op of drained) op.reject(new Error('Aborted'));

      if (!this.#isProcessing) {
        resolve();
        return;
      }
      // Wait for the in-flight op to finish.
      this.#queue.push({ kind: 'abort', args: [], resolve, reject });
    });
  }

  /**
   * Update the codec hint and reset the demuxer.
   * Called when ABR switches to a representation with a different codec string.
   */
  changeType(mimeAndCodecs: string): void {
    this.#codecClass   = classifyTextMimeAndCodecs(mimeAndCodecs);
    this.#warnedImage  = false;
    this.#warnedUnknown = false;
    this.#demuxer.reset();
  }

  /** Switch the TextTrack to 'showing'. */
  show(): void { this.textTrack.mode = 'showing'; }

  /** Switch the TextTrack to 'hidden'. */
  hide(): void { this.textTrack.mode = 'hidden'; }

  // ── Queue pump ────────────────────────────────────────────────────────────

  #pump(): void {
    if (this.#isProcessing || this.#queue.length === 0) return;

    this.#isProcessing = true;
    this.#updating     = true;
    const op           = this.#queue[0];

    // All operations are synchronous internally; wrap in a resolved promise to
    // ensure callers always get async resolution (consistent with real MSB).
    Promise.resolve().then(() => {
      try {
        switch (op.kind) {
          case 'append': this.#doAppend(op.args[0] as ArrayBuffer | ArrayBufferView); break;
          case 'remove': this.#doRemove(op.args[0] as number, op.args[1] as number);  break;
          case 'abort':  /* in-flight op already finished by the time we get here */ break;
        }
        op.resolve();
      } catch (err) {
        // Flush remaining queue — same semantics as ManagedSourceBuffer.
        const ops = this.#queue.splice(0);
        this.#isProcessing = false;
        this.#updating     = false;
        for (const o of ops) o.reject(err as Error);
        return;
      }

      this.#queue.shift();
      this.#isProcessing = false;
      this.#updating     = this.#queue.length > 0;
      this.#pump();
    });
  }

  // ── Internal operations ───────────────────────────────────────────────────

  #doAppend(data: ArrayBuffer | ArrayBufferView): void {
    // Image-profile and unknown codecs: skip with a one-time warning.
    if (this.#codecClass.kind === 'stpp-image') {
      if (!this.#warnedImage) {
        console.warn('[videl] TextSourceBuffer: image-based TTML (stpp-image) is not supported in V1 — segments will be silently discarded.');
        this.#warnedImage = true;
      }
      return;
    }
    if (this.#codecClass.kind === 'unknown') {
      if (!this.#warnedUnknown) {
        console.warn('[videl] TextSourceBuffer: unknown codec — segments will be silently discarded. Classify via the MPD codecs attribute.');
        this.#warnedUnknown = true;
      }
      return;
    }

    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    const off = data instanceof ArrayBuffer ? 0    : (data as ArrayBufferView).byteOffset;
    const len = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;

    // Detect init vs media segment by scanning all top-level boxes for 'moov'.
    // An init segment may be preceded by an 'ftyp' box or other boxes — checking
    // only the very first fourcc misses these cases and would leave the demuxer
    // un-initialised, causing timescale to default to 1 and all cue timestamps
    // to be expressed in raw ticks rather than seconds.
    const view    = new DataView(buf, off, len);
    const isInit  = findBox(view, 0, len, 'moov') !== null;

    if (isInit) {
      this.#demuxer.parseInit(data);
      // Init segments carry no presentation-time data — don't update buffered.
      return;
    }

    // Media segment: demux → parse payloads → inject cues.
    const textSamples = this.#demuxer.parseMedia(data);
    if (textSamples.length === 0) return;

    let minPts = Infinity;
    let maxEnd = -Infinity;

    for (const sample of textSamples) {
      const presentationTime = sample.pts + this.timestampOffset;
      const endTime          = presentationTime + sample.duration;

      // Replace-on-append: remove existing cues in this sample's range first.
      this.#removeCuesInRange(presentationTime, endTime);

      // Parse payload and inject VTTCues.
      if (this.#codecClass.kind === 'wvtt') {
        const cue = parseWvttSample(sample.data);
        if (cue) {
          const vtCue = new VTTCue(presentationTime, endTime, cue.payload);
          vtCue.id    = cue.id;
          applyCueSettings(vtCue, cue.settings);
          this.textTrack.addCue(vtCue);
        }
      } else {
        // stpp-text (stpp, im1t, im2t, etd1)
        const cues = parseStppSample(sample.data);
        for (const c of cues) {
          const cueStart = presentationTime + c.begin;
          const cueEnd   = presentationTime + c.end;
          if (cueStart >= cueEnd) continue;
          const vtCue = new VTTCue(cueStart, cueEnd, c.payload);
          vtCue.id    = c.id;
          this.textTrack.addCue(vtCue);
        }
      }

      if (presentationTime < minPts) minPts = presentationTime;
      if (endTime > maxEnd)          maxEnd = endTime;
    }

    if (minPts < Infinity) {
      this.#bufferedRanges.add(minPts, maxEnd);
    }
  }

  #doRemove(start: number, end: number): void {
    this.#removeCuesInRange(start, end);
    this.#bufferedRanges.cut(start, end);
  }

  /**
   * Remove all cues from textTrack whose range overlaps [start, end).
   * Snapshots the cue list first because removing cues while iterating is unsafe.
   */
  #removeCuesInRange(start: number, end: number): void {
    const cues = this.textTrack.cues;
    if (!cues || cues.length === 0) return;

    // Snapshot to avoid live-collection mutation issues.
    const toRemove: TextTrackCue[] = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (c.startTime < end && c.endTime > start) {
        toRemove.push(c);
      }
    }
    for (const c of toRemove) {
      this.textTrack.removeCue(c);
    }
  }
}
