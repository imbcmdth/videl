/**
 * @videl/lib-ttml — TTML / IMSC stpp sample parser.
 *
 * Parses stpp sample payloads (UTF-8 TTML XML per ISO 14496-30 §7.3) into
 * structured cue data with relative timing. Covers plain stpp, IMSC1 text,
 * IMSC2 text, and EBU-TT-D. Intended to be spun off as a standalone package.
 */
export type { StppCueData } from './parser';
export { parseStppSample } from './parser';
