/**
 * ISourceBuffer — the common interface implemented by both ManagedSourceBuffer
 * (wrapping a real MSE SourceBuffer) and TextSourceBuffer (a fake source
 * buffer that injects cues into a TextTrack).
 *
 * All elements below videl-player (videl-adaptation-set, videl-representation,
 * videl-segment) type their `sourceBuffer` property against this interface so
 * they are entirely agnostic about whether they are feeding real media bytes
 * or text cues.
 *
 * ## Wall-clock coordinate system
 *
 * All time values on this interface are in **wall-clock epoch seconds** —
 * the same coordinate system used by MPD@availabilityStartTime and the
 * segment startTime values in the component tree.
 *
 * `videl-player` sets `wallAnchor` (the wall-clock epoch second corresponding
 * to video.currentTime = 0) on every ISourceBuffer it creates. Implementations
 * translate incoming wall-clock values to player-time by subtracting wallAnchor,
 * and translate outgoing `buffered` ranges back to wall-clock by adding it.
 *
 * For VOD: wallAnchor = 0, so all values are identity-mapped (unchanged).
 * For live-dvr: wallAnchor = activationNow − TSBD; the DVR window start maps
 *   to currentTime = 0 and wall-clock epoch values are shifted accordingly.
 */
export interface ISourceBuffer {
  /**
   * Wall-clock epoch second corresponding to video.currentTime = 0.
   * Set by videl-player after construction, before any other calls.
   *
   * VOD: 0 (identity — wall-clock = currentTime).
   * live: activationNow (live edge ≈ currentTime 0).
   * live-dvr: activationNow − TSBD (DVR start = currentTime 0).
   */
  wallAnchor: number;

  /** Append bytes. For real buffers: MSE appendBuffer. For text: parse + inject cues. */
  append(data: ArrayBuffer | ArrayBufferView): Promise<void>;

  /**
   * Remove buffered content in [start, end).
   * Arguments are **wall-clock epoch seconds**; implementations subtract
   * wallAnchor before passing to the underlying buffer/track.
   */
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

  /**
   * Currently buffered time ranges in **wall-clock epoch seconds**
   * (inner currentTime-space ranges shifted by +wallAnchor).
   */
  readonly buffered: TimeRanges;

  /**
   * Offset added to all media decode times to map them onto wall-clock time.
   * Callers provide a **wall-clock epoch** value; implementations subtract
   * wallAnchor to derive the actual SourceBuffer.timestampOffset.
   *
   * VOD:      periodStart − presentationTimeOffset / timescale  (wallAnchor = 0 → identity)
   * live:     availabilityStartTime
   * live-dvr: availabilityStartTime  (wallAnchor subtraction yields availStart + TSBD − now)
   */
  timestampOffset: number;

  /**
   * Start of the append window in **wall-clock epoch seconds**.
   * Frames before this time are discarded on append.
   * Default: −Infinity (accept all).
   */
  appendWindowStart: number;

  /**
   * End of the append window in **wall-clock epoch seconds**.
   * Frames at or after this time are discarded on append.
   * Default: +Infinity (accept all).
   */
  appendWindowEnd: number;

  /**
   * SourceBuffer mode: 'segments' (absolute timestamps) or 'sequence'
   * (timestamps assigned sequentially). No wall-clock translation needed.
   * TextSourceBuffer always operates in 'segments' mode; setter is a no-op.
   */
  mode: 'segments' | 'sequence';

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
