/**
 * WebVTT-in-ISOBMFF (wvtt) sample parser.
 *
 * Each sample produced by Fmp4TextDemuxer for a `wvtt` track is a sequence
 * of ISOBMFF boxes as defined in ISO 14496-30 §7.4:
 *
 *   vttc  — VTT Cue box (contains the actual cue)
 *     iden  — Cue ID (optional)
 *     sttg  — Cue settings string (optional, e.g. "line:10% align:center")
 *     payl  — Cue payload text (required)
 *   vtte  — Empty cue / timing marker (no text; return null)
 *   vttx  — VTT additional data (ignored)
 *
 * Timing (startTime / endTime) comes from the fMP4 container — the caller
 * (TextSourceBuffer) applies that from the TextSample.pts / .duration fields.
 * This parser only extracts the cue content.
 */

import { findBox, iterBoxes } from './fmp4-box-utils';

export interface WvttCueData {
  id:       string;   // cue identifier (may be empty)
  payload:  string;   // VTT cue text (may contain markup)
  settings: string;   // VTT cue settings string (may be empty)
}

const decoder = new TextDecoder('utf-8');

/**
 * Parse a single wvtt sample payload.
 * Returns `null` for empty cues (`vtte` boxes) or samples with no `vttc`.
 */
export function parseWvttSample(data: Uint8Array): WvttCueData | null {
  // Create a DataView over just this sample's bytes.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Find the vttc box at the top level of the sample.
  const vttc = findBox(view, 0, data.byteLength, 'vttc');
  if (!vttc) return null; // vtte or unrecognised — empty cue

  let id       = '';
  let payload  = '';
  let settings = '';

  // Walk sub-boxes inside vttc.
  for (const sub of iterBoxes(view, vttc.dataStart, vttc.end)) {
    const dataLen = sub.end - sub.dataStart;
    if (dataLen <= 0) continue;

    // Slice the raw bytes relative to the DataView (which is 0-relative over data).
    const textBytes = data.subarray(sub.dataStart, sub.dataStart + dataLen);
    const text      = decoder.decode(textBytes);

    switch (sub.fourcc) {
      case 'iden': id       = text; break;
      case 'payl': payload  = text; break;
      case 'sttg': settings = text; break;
    }
  }

  // A cue with no payload is effectively empty — discard.
  return payload.length > 0 ? { id, payload, settings } : null;
}
