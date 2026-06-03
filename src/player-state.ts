/**
 * PlayerState defines the shape of the state object passed to the update() method
 * of all videl-player elements.
 */
export interface PlayerState {
  currentTime: number;
  /** Combined buffered ranges from the video element (intersection of all SourceBuffers). */
  buffered: TimeRanges;
  bandwidth: number;
  playbackRate: number;
  /**
   * How many seconds of forward buffer to maintain before pausing segment
   * fetches. Segment activation and preloading are suppressed while
   * `bufferedAhead(currentTime, buffered) >= bufferAhead`.
   * Defaults to 30 s when set by `<videl-player>`.
   */
  bufferAhead: number;
  /**
   * Per-content-type buffered TimeRanges snapshotted directly from each MSE
   * SourceBuffer at the start of each pump tick.
   *
   * Keyed by the same `content-type` attribute used on
   * `<videl-adaptation-set>` (e.g. `"video"`, `"audio"`).
   *
   * Unlike `buffered` (which is the intersection of all SourceBuffers),
   * each entry here reflects only that track's buffer — allowing individual
   * representations to make fetch decisions without holding a direct
   * SourceBuffer reference in the hot path.
   */
  sourceBuffered: ReadonlyMap<string, TimeRanges>;
}
