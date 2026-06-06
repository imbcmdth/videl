/**
 * ISourceBuffer — the common interface implemented by both ManagedSourceBuffer
 * (wrapping a real MSE SourceBuffer) and TextSourceBuffer (a fake source
 * buffer that injects cues into a TextTrack).
 *
 * All elements below videl-player (videl-adaptation-set, videl-representation,
 * videl-segment) type their `sourceBuffer` property against this interface so
 * they are entirely agnostic about whether they are feeding real media bytes
 * or text cues.
 */
export interface ISourceBuffer {
  /** Append bytes. For real buffers: MSE appendBuffer. For text: parse + inject cues. */
  append(data: ArrayBuffer | ArrayBufferView): Promise<void>;

  /** Remove buffered content in [start, end). For text: removes cues in range. */
  remove(start: number, end: number): Promise<void>;

  /** Abort the in-flight operation and reject all queued operations. */
  abort(): Promise<void>;

  /**
   * Change the MIME + codecs type.
   * For real buffers: SourceBuffer.changeType().
   * For text: updates codec classification and resets the demuxer.
   */
  changeType(mimeAndCodecs: string): void;

  /** True while an async operation is in progress. */
  readonly updating: boolean;

  /** The currently buffered time ranges. */
  readonly buffered: TimeRanges;

  /**
   * Offset (seconds) added to all media decode times to produce presentation
   * times. Corresponds to SourceBuffer.timestampOffset.
   *
   * Formula: presentationTime = decodeTime / timescale + timestampOffset
   * where timestampOffset = periodStart − presentationTimeOffset / timescale
   */
  timestampOffset: number;

  /**
   * Make the associated TextTrack visible (mode = 'showing').
   * No-op on ManagedSourceBuffer (audio/video have no visibility concept).
   */
  show?(): void;

  /**
   * Hide the associated TextTrack (mode = 'hidden').
   * No-op on ManagedSourceBuffer.
   */
  hide?(): void;
}
