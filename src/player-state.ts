import type { OffsetTimeRanges } from './lib/ergo-mse/offset-time-ranges';

/**
 * PlayerState defines the shape of the state object passed to the videlUpdate()
 * method of all videl elements each pump tick.
 *
 * ## Time coordinate system
 *
 * All time values in PlayerState are in **wall-clock epoch seconds** unless
 * explicitly noted otherwise.
 *
 *   currentWallTime  =  video.currentTime + wallAnchor
 *   wallAnchor       =  wall-clock epoch second at video.currentTime = 0
 *
 * For VOD: wallAnchor = 0, so currentWallTime === video.currentTime.
 * For live-dvr: wallAnchor = activationNow − TSBD.
 */
export interface PlayerState {
  /**
   * Current playback position in **wall-clock epoch seconds**.
   * Primary time field — all component logic should use this.
   *
   * = video.currentTime + wallAnchor
   */
  currentWallTime: number;

  /**
   * Wall-clock epoch second corresponding to video.currentTime = 0.
   *
   * VOD:      0 (identity — wall-clock equals currentTime)
   * live:     activationNow
   * live-dvr: activationNow − timeShiftBufferDepth
   */
  wallAnchor: number;

  /**
   * Raw video.currentTime in player-time space.
   * Kept for logging and debugging only.
   * @deprecated Use currentWallTime for all component logic.
   */
  currentTime: number;

  /**
   * Buffered time ranges in **wall-clock epoch seconds**
   * (video.buffered shifted by +wallAnchor via OffsetTimeRanges).
   */
  buffered: TimeRanges | OffsetTimeRanges;

  /** Combined buffered ranges from the video element (intersection of all SourceBuffers). */
  bandwidth: number;
  playbackRate: number;
  /**
   * How many seconds of forward buffer to maintain before pausing segment
   * fetches. Segment activation and preloading are suppressed while
   * `bufferedAhead(currentWallTime, buffered) >= bufferAhead`.
   * Defaults to 30 s when set by `<videl-player>`.
   */
  bufferAhead: number;
  /**
   * Per-content-type buffered TimeRanges in **wall-clock epoch seconds**,
   * snapshotted from each MSE SourceBuffer (via ManagedSourceBuffer.buffered,
   * which applies +wallAnchor) at the start of each pump tick.
   *
   * Keyed by the same `content-type` attribute used on
   * `<videl-adaptation-set>` (e.g. `"video"`, `"audio"`).
   */
  sourceBuffered: ReadonlyMap<string, TimeRanges>;
  /** Whether the video element is currently paused. Used by presentation controls. */
  paused: boolean;
  /** Current volume level (0–1). Used by presentation controls. */
  volume: number;
  /** Whether the video element is muted. Used by presentation controls. */
  muted: boolean;
  /**
   * Start of the seekable range in **wall-clock epoch seconds**.
   * = video.seekable.start(0) + wallAnchor
   *
   * - **vod:** `0 + 0 = 0` (wallAnchor = 0, identity).
   * - **live:** `0` (no seekable range; seekbar hidden).
   * - **live-dvr:** `(liveEdge − TSBD) + wallAnchor`, advances each tick.
   */
  seekableStart: number;
  /**
   * End of the seekable range in **wall-clock epoch seconds**.
   * = video.seekable.end(last) + wallAnchor
   *
   * - **vod:** `mediaPresentationDuration + 0 = mediaPresentationDuration`.
   * - **live:** `0` (no seekable range; seekbar hidden — value unused).
   * - **live-dvr:** wall-clock live edge, grows at real-time rate.
   */
  seekableEnd: number;
}
