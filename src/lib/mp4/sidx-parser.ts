/**
 * parseSidx — ISOBMFF SegmentIndexBox (ISO 14496-12 §8.16.3) parser.
 *
 * Wire format (big-endian throughout):
 *
 *   // Standard ISOBMFF box header
 *   uint32  size
 *   uint32  fourcc  ('sidx')
 *
 *   // FullBox header
 *   uint8   version   (0 or 1)
 *   uint24  flags     (always 0)
 *
 *   // Box body
 *   uint32  reference_ID     (track_ID of the indexed track — informational)
 *   uint32  timescale        (ticks per second for all time fields in this box)
 *
 *   // version == 0: 32-bit times
 *   uint32  earliest_presentation_time
 *   uint32  first_offset
 *   // version == 1: 64-bit times
 *   uint64  earliest_presentation_time
 *   uint64  first_offset
 *
 *   uint16  reserved         (= 0)
 *   uint16  reference_count
 *
 *   // repeated reference_count times — each entry is exactly 12 bytes:
 *   uint1   reference_type   (0 = media subsegment, 1 = nested sidx)
 *   uint31  referenced_size  (byte length of this subsegment)
 *   uint32  subsegment_duration  (duration in timescale ticks)
 *   uint1   starts_with_SAP
 *   uint3   SAP_type
 *   uint28  SAP_delta_time   (ignored)
 *
 * Byte offset arithmetic:
 *   subsegment_0_start = sidxEndByte + first_offset
 *   subsegment_N_start = subsegment_0_start + sum(referenced_size[0..N-1])
 *   subsegment_N_end   = subsegment_N_start + referenced_size[N] - 1
 *
 * Presentation time arithmetic:
 *   segment_0_startTime = earliest_presentation_time / timescale
 *   segment_N_startTime = segment_0_startTime + sum(subsegment_duration[0..N-1]) / timescale
 *   segment_N_duration  = subsegment_duration[N] / timescale
 *
 * Note: startTime values are media-timeline values — they should be adjusted
 * by the representation's timestampOffset before being used as MSE presentation
 * times, consistent with how all other segment start-time attributes are treated.
 */

import { findBox, readUint32BE, readUint64BE } from './box-utils';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SidxEntry {
  /** Absolute byte range string for the HTTP Range header, e.g. "1024-8191" */
  byteRange: string;
  /** Presentation start time in seconds (media timeline, before timestampOffset) */
  startTime: number;
  /** Duration in seconds */
  duration:  number;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a sidx (SegmentIndexBox) from `buffer`.
 *
 * @param buffer       ArrayBuffer containing the fetched sidx bytes (the
 *                     response body for the indexRange ranged GET).
 * @param sidxEndByte  Absolute byte offset in the media file immediately after
 *                     the last byte of the fetched sidx range
 *                     (= indexRange end + 1).  Used to compute absolute
 *                     subsegment byte addresses via first_offset.
 * @returns            Ordered array of media subsegments.  Entries with
 *                     reference_type == 1 (nested sidx) are skipped with a
 *                     console.warn — recursive sidx chaining is not supported
 *                     in V1.  Returns [] if the buffer contains no valid sidx
 *                     box or is malformed.
 */
export function parseSidx(buffer: ArrayBuffer, sidxEndByte: number): SidxEntry[] {
  if (buffer.byteLength < 32) {
    return [];
  }

  const view = new DataView(buffer);
  const box  = findBox(view, 0, buffer.byteLength, 'sidx');
  if (!box) {
    return [];
  }

  let p = box.dataStart; // cursor into the box data (past the 8-byte header)

  // ── FullBox header ─────────────────────────────────────────────────────────
  // version(1) + flags(3)
  const version = view.getUint8(p);
  p += 4; // skip version + 3 flag bytes

  // ── Box body ───────────────────────────────────────────────────────────────
  // reference_ID (uint32) — informational, skip
  p += 4;

  // timescale (uint32)
  const timescale = readUint32BE(view, p);
  p += 4;
  if (timescale === 0) {
    return [];
  }

  // earliest_presentation_time and first_offset — 32 or 64 bit depending on version
  let earliestPTS: number;
  let firstOffset: number;

  if (version === 0) {
    earliestPTS = readUint32BE(view, p);  p += 4;
    firstOffset = readUint32BE(view, p);  p += 4;
  } else {
    earliestPTS = readUint64BE(view, p);  p += 8;
    firstOffset = readUint64BE(view, p);  p += 8;
  }

  // reserved(2) + reference_count(2)
  p += 2; // skip reserved uint16
  const referenceCount = view.getUint16(p, false);
  p += 2;

  // ── Entries ────────────────────────────────────────────────────────────────
  // Base byte address for the first subsegment (absolute offset in media file).
  // sidxEndByte is the byte immediately after the sidx range, so first_offset
  // is counted from there.
  let byteOffset = sidxEndByte + firstOffset;

  // Running presentation time in seconds.
  let currentTime = earliestPTS / timescale;

  const entries: SidxEntry[] = [];
  let hasWarnedNested = false;

  for (let i = 0; i < referenceCount; i++) {
    if (p + 12 > box.end) {
      break;
    } // truncated — stop

    // First 32 bits: reference_type (1 bit) + referenced_size (31 bits)
    const word0          = readUint32BE(view, p);
    const referenceType  = (word0 >>> 31) & 0x1;
    const referencedSize = word0 & 0x7FFF_FFFF;
    p += 4;

    // Second 32 bits: subsegment_duration
    const subsegmentDuration = readUint32BE(view, p);
    p += 4;

    // Third 32 bits: starts_with_SAP (1) + SAP_type (3) + SAP_delta_time (28)
    // We don't use any of these fields in V1 — skip.
    p += 4;

    if (referenceType === 1) {
      // Nested sidx — skip this entry but keep byte accounting accurate.
      byteOffset  += referencedSize;
      currentTime += subsegmentDuration / timescale;
      if (!hasWarnedNested) {
        console.warn('[videl] sidx: nested sidx reference (reference_type=1) encountered ' +
          '— recursive sidx chaining is not supported; entry skipped.');
        hasWarnedNested = true;
      }
      continue;
    }

    const segStart = byteOffset;
    const segEnd   = byteOffset + referencedSize - 1;
    const duration = subsegmentDuration / timescale;

    entries.push({
      byteRange: `${segStart}-${segEnd}`,
      startTime: currentTime,
      duration
    });

    byteOffset  += referencedSize;
    currentTime += duration;
  }

  return entries;
}
