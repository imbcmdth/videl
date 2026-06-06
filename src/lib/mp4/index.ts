/**
 * @videl/lib-mp4 — Low-level ISOBMFF (ISO 14496-12) utilities.
 *
 * Provides box walking, field readers, and a stateful fMP4 demuxer for
 * text-track segments. Intended to be spun off as a standalone package.
 */
export type { BoxInfo } from './box-utils';
export { iterBoxes, findBox, readUint32BE, readUint64BE, readFourcc } from './box-utils';

export type { TextSample, TextContainerCodec } from './text-demuxer';
export { Fmp4TextDemuxer } from './text-demuxer';
