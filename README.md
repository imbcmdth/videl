# videl-castro

A modern video player library built with TypeScript.

## Foundation

This project provides the foundational types and abstractions for the videl-castro player system.

### PlayerState

The `PlayerState` type defines the shape of the state object passed to the `update()` method of all videl-castro elements. This state is used to make decisions about playback behavior.

### ManagedSourceBuffer

The `ManagedSourceBuffer` is a wrapper around the native `SourceBuffer` that provides a more ergonomic API for appending data. It handles asynchronous operations, queueing, and error handling.

## Installation

```bash
npm install videl-castro
```

## Usage

```typescript
import { PlayerState, ManagedSourceBuffer } from 'videl-castro';

// Use PlayerState in your player elements
const state: PlayerState = {
  currentTime: 10,
  buffered: new TimeRanges(),
  bandwidth: 1000000,
  playbackRate: 1.0
};

// Use ManagedSourceBuffer for handling media segments
const sourceBuffer: ManagedSourceBuffer = /* ... */;
```

## Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```