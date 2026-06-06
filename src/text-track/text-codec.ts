/**
 * Codec string classification for DASH text tracks.
 *
 * The codec string comes from the MPD manifest (e.g. the `codecs` attribute
 * on an AdaptationSet or Representation). It is distinct from the ISOBMFF
 * sample-entry fourcc found in the init segment's `stsd` box — that fourcc
 * is always the top-level container type (`wvtt` or `stpp`), while the codec
 * string captures the sub-profile (IMSC1 text, IMSC1 image, EBU-TT-D, etc.).
 */

export type TextCodecClass =
  | { kind: 'wvtt'       }   // WebVTT-in-ISOBMFF (ISO 14496-30)
  | { kind: 'stpp-text'  }   // All text-profile stpp variants: plain stpp,
                              // stpp.ttml.im1t (IMSC1 text), stpp.ttml.im2t
                              // (IMSC2 text), stpp.ttml.etd1 (EBU-TT-D)
  | { kind: 'stpp-image' }   // Image-profile variants (im1i, im2i) —
                              // bitmap rendering is NOT supported in V1
  | { kind: 'unknown'    };  // Unrecognised codec string

/**
 * Supported codec strings and their classification:
 *
 * | Codec string           | Kind        |
 * |------------------------|-------------|
 * | wvtt                   | wvtt        |
 * | stpp                   | stpp-text   |
 * | stpp.ttml.im1t         | stpp-text   |
 * | stpp.ttml.im2t         | stpp-text   |
 * | stpp.ttml.etd1         | stpp-text   |
 * | stpp.ttml.im1i         | stpp-image  |
 * | stpp.ttml.im2i         | stpp-image  |
 */
export function classifyTextCodec(codec: string): TextCodecClass {
  const c = codec.trim().toLowerCase();
  if (c === 'wvtt') return { kind: 'wvtt' };
  if (c === 'stpp.ttml.im1i' || c === 'stpp.ttml.im2i') return { kind: 'stpp-image' };
  if (c.startsWith('stpp')) return { kind: 'stpp-text' };
  return { kind: 'unknown' };
}

/**
 * Extract the first codec token from a `mimeType; codecs="…"` string,
 * then classify it.
 * Handles bare codec strings too (no mime prefix).
 */
export function classifyTextMimeAndCodecs(mimeAndCodecs: string): TextCodecClass {
  const codecsMatch = mimeAndCodecs.match(/codecs\s*=\s*"([^"]+)"/i);
  if (codecsMatch) {
    // Take the first token (comma-separated list edge case)
    const first = codecsMatch[1].split(',')[0].trim();
    return classifyTextCodec(first);
  }
  // Treat the whole string as a bare codec token.
  return classifyTextCodec(mimeAndCodecs);
}
