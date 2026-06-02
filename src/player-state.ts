/**
 * PlayerState defines the shape of the state object passed to the update() method
 * of all videl-castro elements.
 */
export interface PlayerState {
  currentTime: number;
  buffered: TimeRanges;
  bandwidth: number;
  playbackRate: number;
}