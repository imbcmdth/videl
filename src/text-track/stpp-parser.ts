/**
 * TTML / IMSC stpp sample parser.
 *
 * Each sample produced by Fmp4TextDemuxer for a `stpp` track is a UTF-8
 * TTML XML document (or fragment). Per ISO 14496-30 §7.3, `begin` / `end`
 * times in the sample are expressed relative to the start of the sample —
 * i.e. `00:00:00.000` corresponds to the sample's PTS. The caller
 * (TextSourceBuffer) adds the sample's presentation time to these relative
 * offsets to produce absolute VTTCue start/end times.
 *
 * V1 scope:
 *   - Extracts `<p>` elements from the TTML namespace (and bare `<p>` as a
 *     fallback for non-namespaced documents).
 *   - Parses `begin` / `end` timing attributes in SMPTE clock-time format
 *     (`HH:MM:SS[.fraction]` or `HH:MM:SS:frames`).
 *   - Concatenates text content of each `<p>` as the cue payload.
 *   - Ignores TTML regions, styling, animation, and metadata.
 *   - Logs a warning and returns [] for image-based TTML (`<image>` samples).
 *
 * This single function covers all text-profile stpp variants (plain stpp,
 * stpp.ttml.im1t, stpp.ttml.im2t, stpp.ttml.etd1) because they all use the
 * same `<p begin="…" end="…">` structure.
 */

const TTML_NS = 'http://www.w3.org/ns/ttml';

const decoder = new TextDecoder('utf-8');

export interface StppCueData {
  id:      string;
  payload: string;
  /** Seconds relative to the sample's PTS. */
  begin:   number;
  /** Seconds relative to the sample's PTS. */
  end:     number;
}

/**
 * Parse a single stpp sample payload.
 * @param data  Raw UTF-8 bytes of the TTML XML document.
 * @returns     An array of cue data objects (empty if no parseable cues found).
 */
export function parseStppSample(data: Uint8Array): StppCueData[] {
  const xml = decoder.decode(data);
  let doc: Document;

  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return [];
  }

  // DOMParser parse error is surfaced as a <parsererror> element.
  if (doc.querySelector('parsererror')) return [];

  // Detect image-based TTML: presence of <image> children inside any <p>.
  if (doc.querySelector('image') || doc.querySelector('*|image')) {
    console.warn('[videl] stpp sample contains <image> elements — image-based TTML is not supported in V1; skipping sample.');
    return [];
  }

  // Gather <p> elements (TTML namespace first, fallback to local-name only).
  const paragraphs = Array.from<Element>(
    doc.getElementsByTagNameNS(TTML_NS, 'p').length > 0
      ? doc.getElementsByTagNameNS(TTML_NS, 'p')
      : doc.getElementsByTagName('p'),
  );

  const cues: StppCueData[] = [];

  for (const p of paragraphs) {
    const beginStr = p.getAttribute('begin');
    const endStr   = p.getAttribute('end');
    if (!beginStr || !endStr) continue;

    const begin = parseTtmlTime(beginStr);
    const end   = parseTtmlTime(endStr);
    if (begin === null || end === null || end <= begin) continue;

    const payload = extractText(p).trim();
    if (!payload) continue;

    cues.push({
      id:      p.getAttribute('xml:id') ?? p.getAttribute('id') ?? '',
      payload,
      begin,
      end,
    });
  }

  return cues;
}

// ── TTML clock-time parser ────────────────────────────────────────────────────

/**
 * Parse a TTML clock-time value into seconds.
 * Supported formats:
 *   HH:MM:SS            (integer seconds)
 *   HH:MM:SS.fraction   (fractional seconds)
 *   HH:MM:SS:frames     (drop/non-drop frame; approximated at 30 fps)
 *
 * Returns null for unrecognised formats.
 */
function parseTtmlTime(value: string): number | null {
  const v = value.trim();

  // HH:MM:SS.fraction  (e.g. "00:01:23.456")
  const decimalMatch = v.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (decimalMatch) {
    return (
      parseInt(decimalMatch[1], 10) * 3600 +
      parseInt(decimalMatch[2], 10) * 60   +
      parseFloat(decimalMatch[3])
    );
  }

  // HH:MM:SS:frames  (e.g. "00:01:23:12", approximate at 30 fps)
  const frameMatch = v.match(/^(\d+):(\d{2}):(\d{2}):(\d{2,3})$/);
  if (frameMatch) {
    return (
      parseInt(frameMatch[1], 10) * 3600 +
      parseInt(frameMatch[2], 10) * 60   +
      parseInt(frameMatch[3], 10)         +
      parseInt(frameMatch[4], 10) / 30
    );
  }

  return null;
}

// ── Text extraction ───────────────────────────────────────────────────────────

/**
 * Recursively extract the text content of an element, inserting a single
 * space between adjacent inline elements and a newline for `<br>` / `<tts:br>`.
 */
function extractText(el: Element): string {
  const parts: string[] = [];

  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? '';
      if (t.trim()) parts.push(t);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      const localName = child.localName.toLowerCase();
      if (localName === 'br') {
        parts.push('\n');
      } else {
        const inner = extractText(child);
        if (inner) parts.push(inner);
      }
    }
  }

  return parts.join(' ').replace(/ +\n +/g, '\n').replace(/ {2,}/g, ' ');
}
