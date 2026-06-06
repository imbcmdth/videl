/**
 * Low-level ISOBMFF (ISO 14496-12) box reading utilities shared by
 * Fmp4TextDemuxer and the wvtt sample parser.
 */

export interface BoxInfo {
  fourcc:     string;
  /** Byte offset of the first byte of this box (the size field). */
  start:      number;
  /** 8 for normal boxes, 16 for extended-size boxes. */
  headerSize: number;
  /** Byte offset of the first data byte (immediately after the header). */
  dataStart:  number;
  /** Exclusive end offset of this box. */
  end:        number;
}

export function readUint32BE(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

/**
 * Read a 64-bit big-endian unsigned integer as a JS number.
 * Safe for values up to 2^53 − 1 (sufficient for any realistic timestamp).
 */
export function readUint64BE(view: DataView, offset: number): number {
  const hi = view.getUint32(offset,     false);
  const lo = view.getUint32(offset + 4, false);
  return hi * 0x1_0000_0000 + lo;
}

/** Read a 4-character ASCII box fourcc at the given offset. */
export function readFourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Iterate over the top-level boxes in [start, end) of `view`.
 * Does not recurse — the caller descends into container boxes manually.
 */
export function* iterBoxes(
  view:  DataView,
  start: number,
  end:   number,
): Generator<BoxInfo> {
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = view.getUint32(offset, false);
    const fourcc = readFourcc(view, offset + 4);

    let size:       number;
    let headerSize: number;

    if (size32 === 1) {
      // Extended-size: next 8 bytes are the real 64-bit size.
      if (offset + 16 > end) break;
      size       = readUint64BE(view, offset + 8);
      headerSize = 16;
    } else if (size32 === 0) {
      // Box extends to the end of the containing context.
      size       = end - offset;
      headerSize = 8;
    } else {
      size       = size32;
      headerSize = 8;
    }

    if (size < headerSize) break; // malformed — stop

    yield {
      fourcc,
      start:      offset,
      headerSize,
      dataStart:  offset + headerSize,
      end:        offset + size,
    };

    offset += size;
  }
}

/**
 * Find the first box with the given fourcc in [start, end) of `view`.
 * Returns `null` if not found.
 */
export function findBox(
  view:   DataView,
  start:  number,
  end:    number,
  fourcc: string,
): BoxInfo | null {
  for (const box of iterBoxes(view, start, end)) {
    if (box.fourcc === fourcc) return box;
  }
  return null;
}
