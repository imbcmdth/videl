/**
 * @videl/lib-vtt — WebVTT parsers.
 *
 * Two parsers for two delivery formats:
 *   - `parseWvttSample`  — WebVTT-in-ISOBMFF (wvtt sample payloads, vttc/vtte boxes per ISO 14496-30 §7.4)
 *   - `parseVttFile`     — Standalone WebVTT sidecar files (text/vtt)
 *
 * Intended to be spun off as a standalone package.
 */
export type { WvttCueData } from './parser';
export { parseWvttSample } from './parser';

export type { VttFileCueData } from './file-parser';
export { parseVttFile, parseVttTimestamp } from './file-parser';
