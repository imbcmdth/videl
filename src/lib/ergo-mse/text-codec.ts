/**
 * Codec / MIME-type classification for DASH text tracks.
 *
 * Two delivery models are supported:
 *
 * **fMP4-encapsulated** — segments are ISO Base Media File Format containers.
 * The codec string from the MPD manifest `codecs` attribute names the
 * sample-entry format inside the container (`wvtt`, `stpp`, `stpp.ttml.im1t`,
 * etc.).
 *
 * **Sidecar** — segments are plain text files delivered directly.  The MIME
 * type on the AdaptationSet/Representation identifies the format:
 *   - `text/vtt`              → WebVTT file
 *   - `application/ttml+xml`  → TTML / IMSC XML document
 */

export type TextCodecClass =
  | { kind: 'wvtt'         }  // WebVTT-in-ISOBMFF (ISO 14496-30)
  | { kind: 'stpp-text'    }  // All text-profile stpp variants: plain stpp,
                               // stpp.ttml.im1t (IMSC1 text), stpp.ttml.im2t
                               // (IMSC2 text), stpp.ttml.etd1 (EBU-TT-D)
  | { kind: 'stpp-image'   }  // Image-profile variants (im1i, im2i) —
                               // bitmap rendering not supported
  | { kind: 'vtt-sidecar'  }  // Sidecar WebVTT file (text/vtt)
  | { kind: 'ttml-sidecar' }  // Sidecar TTML document (application/ttml+xml)
  | { kind: 'unknown'      }; // Unrecognised codec / MIME string

/**
 * Classify a bare fMP4 codec string.
 *
 * | Codec string     | Kind        |
 * |------------------|-------------|
 * | wvtt             | wvtt        |
 * | stpp             | stpp-text   |
 * | stpp.ttml.im1t   | stpp-text   |
 * | stpp.ttml.im2t   | stpp-text   |
 * | stpp.ttml.etd1   | stpp-text   |
 * | stpp.ttml.im1i   | stpp-image  |
 * | stpp.ttml.im2i   | stpp-image  |
 */
export function classifyTextCodec(codec: string): TextCodecClass {
  const c = codec.trim().toLowerCase();
  if (c === 'wvtt') {
    return { kind: 'wvtt' };
  }
  if (c === 'stpp.ttml.im1i' || c === 'stpp.ttml.im2i') {
    return { kind: 'stpp-image' };
  }
  if (c.startsWith('stpp')) {
    return { kind: 'stpp-text' };
  }
  return { kind: 'unknown' };
}

/**
 * Classify a full `mimeType` or `mimeType; codecs="…"` string.
 *
 * Sidecar MIME types are matched first (before any codec extraction) so that
 * `text/vtt` and `application/ttml+xml` are never mistakenly routed through
 * the fMP4 codec classifier.
 *
 * For fMP4 types (`application/mp4`, `video/mp4`, etc.) the `codecs="…"`
 * parameter is extracted and classified by `classifyTextCodec`.  A bare
 * codec string with no MIME prefix is also accepted.
 */
export function classifyTextMimeAndCodecs(mimeAndCodecs: string): TextCodecClass {
  const lc = mimeAndCodecs.trim().toLowerCase();

  // ── Sidecar MIME types ────────────────────────────────────────────────────
  if (lc === 'text/vtt' || lc.startsWith('text/vtt;') || lc.startsWith('text/vtt ')) {
    return { kind: 'vtt-sidecar' };
  }
  if (
    lc === 'application/ttml+xml' ||
    lc.startsWith('application/ttml+xml;') ||
    lc.startsWith('application/ttml+xml ')
  ) {
    return { kind: 'ttml-sidecar' };
  }

  // ── fMP4 codec string ─────────────────────────────────────────────────────
  const codecsMatch = mimeAndCodecs.match(/codecs\s*=\s*"([^"]+)"/i);
  if (codecsMatch) {
    const first = codecsMatch[1].split(',')[0].trim();
    return classifyTextCodec(first);
  }

  // Treat the whole string as a bare codec token.
  return classifyTextCodec(mimeAndCodecs);
}
