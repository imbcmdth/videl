/**
 * Fmp4TextDemuxer — stateful fMP4 parser for text-track segments.
 *
 * Usage:
 *   const demuxer = new Fmp4TextDemuxer();
 *   demuxer.parseInit(initSegmentBytes);   // call once per representation
 *   const samples = demuxer.parseMedia(mediaSegmentBytes);
 *
 * The demuxer reads timescale and container codec from the init segment's
 * `moov` box, then extracts per-sample PTS, duration, and raw payload bytes
 * from each media segment's `moof` + `mdat` boxes.
 *
 * NOTE: The container codec (`wvtt` or `stpp`) read from `stsd` is the
 * top-level ISOBMFF sample-entry fourcc. All TTML sub-profiles (IMSC1 text,
 * EBU-TT-D, etc.) share the `stpp` fourcc. Sub-profile discrimination uses
 * the codec string from the MPD manifest — handled at the TextSourceBuffer
 * level, not here.
 */

import { findBox, readUint32BE, readUint64BE, readFourcc } from './box-utils';

export interface TextSample {
  /**
   * Presentation timestamp in seconds, computed as:
   *   (baseMediaDecodeTime + sampleDtOffset) / timescale
   *
   * This is the raw media-timeline value BEFORE adding TextSourceBuffer's
   * timestampOffset. The caller applies that offset when constructing cues.
   */
  pts:      number;
  /** Duration in seconds. */
  duration: number;
  /** Raw sample payload bytes (a copy — not a view into the source buffer). */
  data:     Uint8Array;
}

/**
 * The top-level container codec, read from the `stsd` sample-entry fourcc.
 * Always either 'wvtt' or 'stpp' for text tracks; 'unknown' if the init
 * segment hasn't been parsed yet or the fourcc is unrecognised.
 */
export type TextContainerCodec = 'wvtt' | 'stpp' | 'unknown';

export class Fmp4TextDemuxer {
  #timescale:      number             = 1;
  #containerCodec: TextContainerCodec = 'unknown';

  get timescale():      number             {
    return this.#timescale;
  }
  get containerCodec(): TextContainerCodec {
    return this.#containerCodec;
  }

  /** Reset state so a new init segment can be parsed (e.g. after changeType). */
  reset(): void {
    this.#timescale      = 1;
    this.#containerCodec = 'unknown';
  }

  // ── Init segment ───────────────────────────────────────────────────────────

  /**
   * Parse an fMP4 init segment (contains a `moov` box).
   * Reads `timescale` from `mdhd` and the container codec from `stsd`.
   */
  parseInit(data: ArrayBuffer | ArrayBufferView): void {
    const buf  = data instanceof ArrayBuffer ? data : data.buffer;
    const off  = data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset;
    const len  = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;
    const view = new DataView(buf, off, len);

    const moov = findBox(view, 0, len, 'moov');
    if (!moov) {
      return;
    }

    // moov → trak → mdia
    const trak = findBox(view, moov.dataStart, moov.end, 'trak');
    if (!trak) {
      return;
    }

    const mdia = findBox(view, trak.dataStart, trak.end, 'mdia');
    if (!mdia) {
      return;
    }

    // mdhd: version(1) + flags(3) + [creation v0:4/v1:8] + [modification v0:4/v1:8] + timescale(4)
    const mdhd = findBox(view, mdia.dataStart, mdia.end, 'mdhd');
    if (mdhd) {
      const version      = view.getUint8(mdhd.dataStart);
      const tsOffset     = mdhd.dataStart + 4 + (version === 1 ? 16 : 8);
      this.#timescale    = readUint32BE(view, tsOffset);
    }

    // moov → trak → mdia → minf → stbl → stsd → first sample-entry fourcc
    const minf = findBox(view, mdia.dataStart, mdia.end, 'minf');
    if (!minf) {
      return;
    }

    const stbl = findBox(view, minf.dataStart, minf.end, 'stbl');
    if (!stbl) {
      return;
    }

    const stsd = findBox(view, stbl.dataStart, stbl.end, 'stsd');
    if (!stsd) {
      return;
    }

    // stsd: version(1) + flags(3) + entry_count(4) + [first entry: size(4) + fourcc(4) + ...]
    const firstEntryFourccOffset = stsd.dataStart + 8; // skip version/flags(4) + entry_count(4)
    if (firstEntryFourccOffset + 8 <= stsd.end) {
      const fourcc = readFourcc(view, firstEntryFourccOffset + 4);

      if (fourcc === 'wvtt' || fourcc === 'stpp') {
        this.#containerCodec = fourcc;
      } else {
        this.#containerCodec = 'unknown';
      }
    }
  }

  // ── Media segment ──────────────────────────────────────────────────────────

  /**
   * Parse an fMP4 media segment (contains `moof` + `mdat` boxes).
   * Returns one TextSample per encoded sample, in presentation order.
   */
  parseMedia(data: ArrayBuffer | ArrayBufferView): TextSample[] {
    const buf  = data instanceof ArrayBuffer ? data : data.buffer;
    const off  = data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset;
    const len  = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;
    const view = new DataView(buf, off, len);

    const samples: TextSample[] = [];

    // Find moof (may not start at offset 0 if there is a styp box first)
    const moof = findBox(view, 0, len, 'moof');
    if (!moof) {
      return samples;
    }

    const moofStart = moof.start;
    const moofEnd   = moof.end;

    // moof → traf
    const traf = findBox(view, moof.dataStart, moofEnd, 'traf');
    if (!traf) {
      return samples;
    }

    // ── tfhd: default sample duration/size ──────────────────────────────────
    let defaultSampleDuration = 0;
    let defaultSampleSize     = 0;

    const tfhd = findBox(view, traf.dataStart, traf.end, 'tfhd');
    if (tfhd) {
      const tfhdFlags =
        (view.getUint8(tfhd.dataStart + 1) << 16) |
        (view.getUint8(tfhd.dataStart + 2) << 8)  |
         view.getUint8(tfhd.dataStart + 3);

      let p = tfhd.dataStart + 8; // skip version(1)+flags(3)+track_id(4)
      if (tfhdFlags & 0x000001) {
        p += 8;
      } // base_data_offset
      if (tfhdFlags & 0x000002) {
        p += 4;
      } // sample_description_index
      if (tfhdFlags & 0x000008) {
        defaultSampleDuration = readUint32BE(view, p); p += 4;
      }
      if (tfhdFlags & 0x000010) {
        defaultSampleSize     = readUint32BE(view, p);
      }
    }

    // ── tfdt: base media decode time ────────────────────────────────────────
    let baseMediaDecodeTime = 0;

    const tfdt = findBox(view, traf.dataStart, traf.end, 'tfdt');
    if (tfdt) {
      const version = view.getUint8(tfdt.dataStart);
      baseMediaDecodeTime = version === 1 ?
        readUint64BE(view, tfdt.dataStart + 4) :
        readUint32BE(view, tfdt.dataStart + 4);
    }

    // ── trun: per-sample info ───────────────────────────────────────────────
    const trun = findBox(view, traf.dataStart, traf.end, 'trun');
    if (!trun) {
      return samples;
    }

    const trunFlags =
      (view.getUint8(trun.dataStart + 1) << 16) |
      (view.getUint8(trun.dataStart + 2) << 8)  |
       view.getUint8(trun.dataStart + 3);

    const sampleCount = readUint32BE(view, trun.dataStart + 4);

    const dataOffsetPresent       = (trunFlags & 0x000001) !== 0;
    const firstSampleFlagsPresent = (trunFlags & 0x000004) !== 0;
    const sampleDurationPresent   = (trunFlags & 0x000100) !== 0;
    const sampleSizePresent       = (trunFlags & 0x000200) !== 0;
    const sampleFlagsPresent      = (trunFlags & 0x000400) !== 0;
    const sampleCtsOffsetPresent  = (trunFlags & 0x000800) !== 0;

    let trunOffset = trun.dataStart + 8; // past version+flags+sample_count

    let dataOffset = 0;
    if (dataOffsetPresent)        {
      dataOffset = view.getInt32(trunOffset, false); trunOffset += 4;
    }
    if (firstSampleFlagsPresent)  {
      trunOffset += 4;
    }

    // Per ISO 14496-12 §8.8.8: data_offset is relative to base_data_offset
    // which defaults to the start of the enclosing Movie Fragment Box.
    let firstSampleAbsOffset: number;
    if (dataOffsetPresent) {
      firstSampleAbsOffset = moofStart + dataOffset;
    } else {
      const mdat = findBox(view, moofEnd, len, 'mdat');
      firstSampleAbsOffset = mdat ? mdat.dataStart : moofEnd + 8;
    }

    interface SampleMeta { dt: number; duration: number; size: number; }
    const metas: SampleMeta[] = [];
    let dtAccum = baseMediaDecodeTime;

    for (let i = 0; i < sampleCount; i++) {
      let duration = defaultSampleDuration;
      let size     = defaultSampleSize;

      if (sampleDurationPresent)  {
        duration = readUint32BE(view, trunOffset); trunOffset += 4;
      }
      if (sampleSizePresent)      {
        size     = readUint32BE(view, trunOffset); trunOffset += 4;
      }
      if (sampleFlagsPresent)     {
        trunOffset += 4;
      }
      if (sampleCtsOffsetPresent) {
        trunOffset += 4;
      }

      metas.push({ dt: dtAccum, duration, size });
      dtAccum += duration;
    }

    let byteOffset = firstSampleAbsOffset;
    const ts = this.#timescale || 1;

    for (const { dt, duration, size } of metas) {
      if (size > 0 && byteOffset + size <= len) {
        const rawSlice = new Uint8Array(buf, off + byteOffset, size);
        const copied   = new Uint8Array(size);
        copied.set(rawSlice);

        samples.push({
          pts: dt       / ts,
          duration: duration / ts,
          data: copied
        });
      }
      byteOffset += size;
    }

    return samples;
  }
}
