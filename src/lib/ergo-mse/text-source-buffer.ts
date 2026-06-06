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
import { Fmp4TextDemuxer } from '../mp4/text-demuxer';
import { classifyTextMimeAndCodecs } from './text-codec';
import type { TextCodecClass } from './text-codec';
import { findBox } from '../mp4/box-utils';
import { parseWvttSample } from '../vtt/parser';
import { parseVttFile } from '../vtt/file-parser';
import { parseStppSample } from '../ttml/parser';

// ── VTT settings → VTTCue properties ──────────────────────────────────────────

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
  readonly textTrack: TextTrack;

  timestampOffset = 0;

  #updating       = false;
  #bufferedRanges = new SyntheticTimeRanges();

  #demuxer        = new Fmp4TextDemuxer();
  #codecClass:    TextCodecClass = { kind: 'unknown' };
  #warnedImage    = false;
  #warnedUnknown  = false;

  #queue:         QueueEntry[] = [];
  #isProcessing   = false;

  /**
   * @param videoEl    The HTMLVideoElement that will own the TextTrack.
   * @param label      Display label shown in the browser's track selector.
   * @param lang       BCP-47 language tag (e.g. "en", "fr").
   * @param codecHint  Codec string from the MPD manifest (e.g. "stpp.ttml.im1t").
   */
  constructor(
    videoEl:   HTMLVideoElement,
    label:     string,
    lang:      string,
    codecHint: string = '',
  ) {
    this.textTrack      = videoEl.addTextTrack('subtitles', label, lang);
    this.textTrack.mode = 'hidden';
    this.#codecClass    = classifyTextMimeAndCodecs(codecHint);
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
      const startIdx = this.#isProcessing ? 1 : 0;
      const drained  = this.#queue.splice(startIdx);
      for (const op of drained) op.reject(new Error('Aborted'));

      if (!this.#isProcessing) { resolve(); return; }
      this.#queue.push({ kind: 'abort', args: [], resolve, reject });
    });
  }

  /**
   * Update the codec hint and reset the demuxer.
   * Called when an ADS switch changes the codec string — without this,
   * the demuxer would still be configured for the old codec.
   */
  changeType(mimeAndCodecs: string): void {
    this.#codecClass    = classifyTextMimeAndCodecs(mimeAndCodecs);
    this.#warnedImage   = false;
    this.#warnedUnknown = false;
    this.#demuxer.reset();
  }

  show(): void { this.textTrack.mode = 'showing'; }
  hide(): void { this.textTrack.mode = 'hidden';  }

  // ── Queue pump ────────────────────────────────────────────────────────────

  #pump(): void {
    if (this.#isProcessing || this.#queue.length === 0) return;

    this.#isProcessing = true;
    this.#updating     = true;
    const op           = this.#queue[0];

    Promise.resolve().then(() => {
      try {
        switch (op.kind) {
          case 'append': this.#doAppend(op.args[0] as ArrayBuffer | ArrayBufferView); break;
          case 'remove': this.#doRemove(op.args[0] as number, op.args[1] as number);  break;
          case 'abort':  break;
        }
        op.resolve();
      } catch (err) {
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
    switch (this.#codecClass.kind) {
      case 'stpp-image':
        if (!this.#warnedImage) {
          console.warn('[videl] TextSourceBuffer: image-based TTML (stpp-image) is not supported — segments will be silently discarded.');
          this.#warnedImage = true;
        }
        return;

      case 'unknown':
        if (!this.#warnedUnknown) {
          console.warn('[videl] TextSourceBuffer: unknown codec — segments will be silently discarded. Classify via the MPD codecs attribute.');
          this.#warnedUnknown = true;
        }
        return;

      case 'vtt-sidecar':
        this.#appendSidecarVtt(data);
        return;

      case 'ttml-sidecar':
        this.#appendSidecarTtml(data);
        return;
    }

    // ── fMP4-encapsulated path (wvtt / stpp-text) ─────────────────────────────

    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    const off = data instanceof ArrayBuffer ? 0    : (data as ArrayBufferView).byteOffset;
    const len = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;

    // Scan all top-level boxes for 'moov' — init segments may be preceded by
    // 'ftyp' or other boxes, so checking only the first box fourcc is wrong.
    const view   = new DataView(buf, off, len);
    const isInit = findBox(view, 0, len, 'moov') !== null;

    if (isInit) {
      this.#demuxer.parseInit(data);
      return;
    }

    const textSamples = this.#demuxer.parseMedia(data);
    if (textSamples.length === 0) return;

    let minPts = Infinity;
    let maxEnd = -Infinity;

    for (const sample of textSamples) {
      const presentationTime = sample.pts + this.timestampOffset;
      const endTime          = presentationTime + sample.duration;

      if (this.#codecClass.kind === 'wvtt') {
        // wvtt: timing comes entirely from the fMP4 container (tfdt + trun).
        // The vttc payload carries only the cue text/settings, no timestamps.
        this.#removeCuesInRange(presentationTime, endTime);
        const cue = parseWvttSample(sample.data);
        if (cue) {
          const vtCue = new VTTCue(presentationTime, endTime, cue.payload);
          vtCue.id    = cue.id;
          applyCueSettings(vtCue, cue.settings);
          this.textTrack.addCue(vtCue);
        }
        if (presentationTime < minPts) minPts = presentationTime;
        if (endTime > maxEnd)          maxEnd = endTime;
      } else {
        // stpp-text (stpp, im1t, im2t, etd1):
        // begin/end in the TTML document are ABSOLUTE presentation times, not
        // relative to the sample PTS. DASH-IF and real-world encoders write
        // wall-clock presentation times in the XML; adding sample.pts would
        // shift every cue later by the segment's position in the timeline.
        // Only timestampOffset is applied (period start – pto/timescale).
        const cues = parseStppSample(sample.data);
        for (const c of cues) {
          const cueStart = c.begin + this.timestampOffset;
          const cueEnd   = c.end   + this.timestampOffset;
          if (cueStart >= cueEnd) continue;
          this.#removeCuesInRange(cueStart, cueEnd);
          const vtCue = new VTTCue(cueStart, cueEnd, c.payload);
          vtCue.id    = c.id;
          this.textTrack.addCue(vtCue);
          if (cueStart < minPts) minPts = cueStart;
          if (cueEnd   > maxEnd) maxEnd = cueEnd;
        }
      }
    }

    if (minPts < Infinity) {
      this.#bufferedRanges.add(minPts, maxEnd);
    }
  }

  // ── Sidecar helpers ───────────────────────────────────────────────────────

  /**
   * Append a sidecar WebVTT file (text/vtt).
   * Cue times in the VTT file are absolute presentation times. `timestampOffset`
   * is applied on top (same as for fMP4 paths) to handle multi-period alignment.
   * There is no separate init segment — every append is the full file content.
   */
  #appendSidecarVtt(data: ArrayBuffer | ArrayBufferView): void {
    const buf   = data instanceof ArrayBuffer ? data : data.buffer;
    const off   = data instanceof ArrayBuffer ? 0    : (data as ArrayBufferView).byteOffset;
    const len   = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;
    const bytes = new Uint8Array(buf, off, len);

    const cues = parseVttFile(bytes);
    if (cues.length === 0) return;

    let minPts = Infinity;
    let maxEnd = -Infinity;

    for (const c of cues) {
      const startTime = c.startTime + this.timestampOffset;
      const endTime   = c.endTime   + this.timestampOffset;
      if (startTime >= endTime) continue;

      this.#removeCuesInRange(startTime, endTime);

      const vtCue = new VTTCue(startTime, endTime, c.payload);
      vtCue.id    = c.id;
      applyCueSettings(vtCue, c.settings);
      this.textTrack.addCue(vtCue);

      if (startTime < minPts) minPts = startTime;
      if (endTime   > maxEnd) maxEnd = endTime;
    }

    if (minPts < Infinity) this.#bufferedRanges.add(minPts, maxEnd);
  }

  /**
   * Append a sidecar TTML document (application/ttml+xml).
   * Reuses `parseStppSample` — the XML format is identical to fMP4 stpp.
   * Cue `begin`/`end` are absolute presentation times; only `timestampOffset`
   * is applied. This is the same logic as fMP4 stpp-text.
   */
  #appendSidecarTtml(data: ArrayBuffer | ArrayBufferView): void {
    const buf   = data instanceof ArrayBuffer ? data : data.buffer;
    const off   = data instanceof ArrayBuffer ? 0    : (data as ArrayBufferView).byteOffset;
    const len   = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;
    const bytes = new Uint8Array(buf, off, len);

    // parseStppSample returns relative begin/end. For sidecar TTML those values
    // ARE the absolute presentation times (equivalent to pts=0 fMP4 sample).
    const cues = parseStppSample(bytes);
    if (cues.length === 0) return;

    let minPts = Infinity;
    let maxEnd = -Infinity;

    for (const c of cues) {
      const startTime = c.begin + this.timestampOffset;
      const endTime   = c.end   + this.timestampOffset;
      if (startTime >= endTime) continue;

      this.#removeCuesInRange(startTime, endTime);

      const vtCue = new VTTCue(startTime, endTime, c.payload);
      vtCue.id    = c.id;
      this.textTrack.addCue(vtCue);

      if (startTime < minPts) minPts = startTime;
      if (endTime   > maxEnd) maxEnd = endTime;
    }

    if (minPts < Infinity) this.#bufferedRanges.add(minPts, maxEnd);
  }

  #doRemove(start: number, end: number): void {
    this.#removeCuesInRange(start, end);
    this.#bufferedRanges.cut(start, end);
  }

  #removeCuesInRange(start: number, end: number): void {
    const cues = this.textTrack.cues;
    if (!cues || cues.length === 0) return;

    const toRemove: TextTrackCue[] = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (c.startTime < end && c.endTime > start) toRemove.push(c);
    }
    for (const c of toRemove) this.textTrack.removeCue(c);
  }
}
