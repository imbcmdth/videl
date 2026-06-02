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

/**
 * ManagedSourceBuffer is a wrapper around the native SourceBuffer that provides
 * a more ergonomic API for appending data. It handles asynchronous operations,
 * queueing, and error handling.
 */
export interface ManagedSourceBuffer {
  // Properties
  mode: SourceBufferMode;
  timestampOffset: number;
  appendWindowStart: number;
  appendWindowEnd: number;
  audioTracks: AudioTrackList;
  videoTracks: VideoTrackList;
  textTracks: TextTrackList;
  
  // Methods
  append(bytes: Uint8Array): Promise<void>;
  abort(): void;
  remove(start: number, end: number): void;
  updateTimestampOffset(offset: number): void;
  updateAppendWindow(start: number, end: number): void;
  
  // Events
  onupdatestart: (event: Event) => void;
  onupdate: (event: Event) => void;
  onupdateend: (event: Event) => void;
  onerror: (event: Event) => void;
}