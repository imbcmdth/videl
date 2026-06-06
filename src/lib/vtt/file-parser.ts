/**
 * Standalone WebVTT file parser.
 *
 * Parses a plain `.vtt` file (as delivered by `text/vtt` segments in DASH)
 * into an array of cue data objects. This is distinct from `parser.ts`, which
 * handles the ISOBMFF-encapsulated wvtt format (vttc/vtte boxes inside mdat).
 *
 * WebVTT spec reference: https://www.w3.org/TR/webvtt1/
 *
 * Supported:
 *   - WEBVTT header (required)
 *   - Cue ID lines (optional)
 *   - Timing lines: `HH:MM:SS.mmm --> HH:MM:SS.mmm [settings]`
 *     and the abbreviated `MM:SS.mmm` form
 *   - Multi-line cue payload
 *   - NOTE, STYLE, REGION blocks (skipped)
 *   - BOM stripping
 *
 * Not supported (silently ignored):
 *   - `<ruby>`, `<rt>`, `<v>`, `<lang>` inline VTT markup — payload text
 *     is preserved as-is and the browser's VTTCue renderer handles it
 */

const decoder = new TextDecoder('utf-8');

export interface VttFileCueData {
  /** Cue identifier (may be empty). */
  id:        string;
  /** Absolute presentation time in seconds. */
  startTime: number;
  /** Absolute presentation time in seconds. */
  endTime:   number;
  /** Cue payload text (may contain VTT markup). */
  payload:   string;
  /** VTT cue settings string (e.g. `"line:10% align:center"`). */
  settings:  string;
}

/**
 * Parse a raw WebVTT file (UTF-8 bytes) into an array of cue data objects.
 * Returns an empty array if the data is not valid WebVTT.
 */
export function parseVttFile(data: Uint8Array): VttFileCueData[] {
  const raw     = decoder.decode(data);
  // Strip BOM if present.
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  // Normalise line endings.
  const lines = content.split(/\r\n|\r|\n/);

  // First non-empty line must start with "WEBVTT".
  const firstLine = lines[0] ?? '';
  if (!firstLine.startsWith('WEBVTT')) return [];

  const cues: VttFileCueData[] = [];
  let i = 1; // start after the WEBVTT header

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Skip empty lines between blocks.
    if (!line.trim()) { i++; continue; }

    // Skip NOTE / STYLE / REGION blocks (read until next empty line).
    if (
      line.startsWith('NOTE')   ||
      line.startsWith('STYLE')  ||
      line.startsWith('REGION')
    ) {
      i++;
      while (i < lines.length && (lines[i] ?? '').trim()) i++;
      continue;
    }

    // Determine whether this line is a cue ID or a timing line.
    let id          = '';
    let timingLine  = line;

    if (!line.includes('-->')) {
      // This line is a cue ID; the next line should be the timing.
      id         = line.trim();
      i++;
      timingLine = lines[i] ?? '';
    }

    if (!timingLine.includes('-->')) {
      // Not a timing line — skip past this block.
      i++;
      continue;
    }

    // Parse the timing line.
    // Format: <start> --> <end> [settings]
    // where <start>/<end> are HH:MM:SS.mmm or MM:SS.mmm
    const timingMatch = timingLine.match(
      /^(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/
    );
    if (!timingMatch) { i++; continue; }

    const startTime = parseVttTimestamp(timingMatch[1]);
    const endTime   = parseVttTimestamp(timingMatch[2]);
    const settings  = (timingMatch[3] ?? '').trim();

    if (startTime === null || endTime === null || endTime <= startTime) {
      i++;
      continue;
    }

    i++; // advance past the timing line

    // Collect cue payload lines until the next empty line or EOF.
    const payloadLines: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim()) {
      payloadLines.push(lines[i]!);
      i++;
    }

    if (payloadLines.length === 0) continue;

    cues.push({
      id,
      startTime,
      endTime,
      payload:  payloadLines.join('\n'),
      settings,
    });
  }

  return cues;
}

// ── Timestamp parsing ──────────────────────────────────────────────────────────

/**
 * Parse a WebVTT timestamp string into seconds.
 *
 * Accepts:
 *   HH:MM:SS.mmm   (hours optional)
 *   MM:SS.mmm
 *
 * Returns null for unrecognised formats.
 */
export function parseVttTimestamp(value: string): number | null {
  // Optional HH: prefix
  const match = value.match(
    /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/
  );
  if (!match) return null;

  const hours   = parseInt(match[1] ?? '0', 10);
  const minutes = parseInt(match[2],         10);
  const seconds = parseInt(match[3],         10);
  const millis  = parseInt(match[4],         10);

  if (minutes >= 60 || seconds >= 60) return null;

  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}
