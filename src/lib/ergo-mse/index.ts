/**
 * @videl/lib-ergo-mse — Ergonomic MSE abstractions.
 *
 * Provides a common ISourceBuffer interface implemented by both
 * ManagedSourceBuffer (real MSE SourceBuffer wrapper) and TextSourceBuffer
 * (TextTrack-backed fake source buffer for DASH text tracks). Supporting
 * types: SyntheticTimeRanges and the codec classifier. Intended to be spun
 * off as a standalone package.
 */
export type { ISourceBuffer } from './i-source-buffer';

export type { TextCodecClass } from './text-codec';
export { classifyTextCodec, classifyTextMimeAndCodecs } from './text-codec';

export { SyntheticTimeRanges } from './synthetic-time-ranges';

export { ManagedSourceBuffer } from './managed-source-buffer';
export { TextSourceBuffer } from './text-source-buffer';
