/**
 * ErgoMediaSource — a thin ergonomic wrapper around the browser's MediaSource
 * API that transparently routes text MIME types to TextSourceBuffer (backed by
 * a TextTrack) while delegating audio/video MIME types to the real MSE
 * SourceBuffer via ManagedSourceBuffer.
 *
 * Usage:
 *
 *   const mse = new ErgoMediaSource();
 *   await mse.attach(videoElement);        // replaces the sourceopen event
 *   const sb  = mse.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
 *   const tsb = mse.addSourceBuffer('application/mp4; codecs="wvtt"', { lang: 'en' });
 *   // … append segments …
 *   mse.detach();                          // revokes the object URL and resets
 */

import type { ISourceBuffer } from './i-source-buffer';
import { ManagedSourceBuffer } from './managed-source-buffer';
import { TextSourceBuffer } from './text-source-buffer';
import { classifyTextMimeAndCodecs } from './text-codec';

export interface AddSourceBufferOptions {
  /** Human-readable label for the TextTrack (text tracks only). */
  label?: string;
  /** BCP-47 language tag for the TextTrack (text tracks only). */
  lang?: string;
}

/**
 * `ErgoMediaSource` wraps `MediaSource` with two improvements:
 *
 * 1. **Promise-based attachment** — `attach(videoEl)` replaces the awkward
 *    `sourceopen` event pattern.  You `await` it and the source is ready.
 *
 * 2. **Transparent text tracks** — `addSourceBuffer()` accepts text MIME
 *    types (`text/vtt`, `application/ttml+xml`, `application/mp4; codecs="wvtt"`,
 *    etc.) and returns a `TextSourceBuffer` instead of throwing; no separate
 *    code path is needed by the caller.
 */
export class ErgoMediaSource {
  readonly #ms: MediaSource;
  #videoEl: HTMLVideoElement | null = null;
  #objectUrl: string | null = null;

  /**
   * Wall-clock epoch second corresponding to video.currentTime = 0.
   * Set by videl-player after sourceopen, before any setLiveSeekableRange calls.
   *
   * VOD:      0  (identity — player-time equals wall-clock)
   * live:     activationNow
   * live-dvr: activationNow − TSBD
   */
  wallAnchor = 0;

  constructor() {
    this.#ms = new MediaSource();
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  /**
   * Returns `true` if the browser can play the given MIME/codec string OR if
   * it is a text codec handled by `TextSourceBuffer`.  Mirrors the native
   * `MediaSource.isTypeSupported` signature.
   */
  static isTypeSupported(mimeAndCodecs: string): boolean {
    const cls = classifyTextMimeAndCodecs(mimeAndCodecs);
    if (cls.kind !== 'unknown') {
      return true;
    }
    return MediaSource.isTypeSupported(mimeAndCodecs);
  }

  // ── Attachment ────────────────────────────────────────────────────────────

  /**
   * Attach this `ErgoMediaSource` to `videoEl` and wait until the underlying
   * `MediaSource` is open and ready to accept source buffers.
   *
   * Calling `addSourceBuffer()` before this promise resolves will throw.
   *
   * @param videoEl  The `<video>` element to drive.
   * @param signal   Optional `AbortSignal`; rejects with `AbortError` if signalled.
   */
  attach(videoEl: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
    this.#videoEl = videoEl;
    const url     = URL.createObjectURL(this.#ms);
    this.#objectUrl = url;
    videoEl.src   = url;

    return new Promise<void>((resolve, reject) => {
      let cleanup: () => void;
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onErr = (): void => {
        cleanup();
        reject(new Error('MediaSource error on attach'));
      };
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      cleanup = (): void => {
        this.#ms.removeEventListener('sourceopen', onOpen);
        this.#ms.removeEventListener('error', onErr);
        signal?.removeEventListener('abort', onAbort);
      };

      this.#ms.addEventListener('sourceopen', onOpen, { once: true });
      this.#ms.addEventListener('error', onErr, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Revoke the object URL, reset the video element's `src`, and call
   * `endOfStream()` if the underlying `MediaSource` is still open.
   *
   * TextTracks cannot be removed from a video element once added, so callers
   * are responsible for clearing cues on any `TextSourceBuffer` instances
   * before calling `detach()`.
   */
  detach(): void {
    try {
      if (this.#ms.readyState === 'open') {
        this.#ms.endOfStream();
      }
    } catch { /* ignore — already closed or errored */ }

    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
    }

    if (this.#videoEl) {
      this.#videoEl.removeAttribute('src');
      this.#videoEl.load();
      this.#videoEl = null;
    }
  }

  // ── Source buffer factory ─────────────────────────────────────────────────

  /**
   * Add a source buffer for the given MIME/codec string.
   *
   * - **Audio/video** types are handled by the real MSE `SourceBuffer` wrapped
   *   in a `ManagedSourceBuffer` (promise-based, queued).
   * - **Text** types (`text/vtt`, `application/ttml+xml`, fMP4 `wvtt`/`stpp`,
   *   etc.) are handled by a `TextSourceBuffer` backed by a `TextTrack` on the
   *   attached `<video>` element.
   *
   * Must be called after `attach()` resolves.
   *
   * @param mimeAndCodecs  Standard `mimeType` or `mimeType; codecs="…"` string.
   * @param options        Optional label/lang for text track creation.
   */
  addSourceBuffer(mimeAndCodecs: string, options: AddSourceBufferOptions = {}): ISourceBuffer {
    if (!this.#videoEl) {
      throw new Error('ErgoMediaSource: call attach() before addSourceBuffer()');
    }

    const cls = classifyTextMimeAndCodecs(mimeAndCodecs);
    if (cls.kind !== 'unknown') {
      const label = options.label ?? options.lang ?? 'subtitles';
      const lang  = options.lang ?? '';
      return new TextSourceBuffer(this.#videoEl, label, lang, mimeAndCodecs);
    }

    const sb = this.#ms.addSourceBuffer(mimeAndCodecs);
    return new ManagedSourceBuffer(sb);
  }

  // ── MediaSource passthrough ───────────────────────────────────────────────

  /** The underlying `MediaSource` ready state. */
  get readyState(): ReadyState {
    return this.#ms.readyState;
  }

  /** Get/set the presentation duration (delegates to `MediaSource.duration`). */
  get duration(): number {
    return this.#ms.duration;
  }
  set duration(v: number) {
    this.#ms.duration = v;
  }

  /**
   * Signal the end of the media stream.  Optionally pass an error string
   * (`'network'` or `'decode'`) to signal a fatal error to the browser.
   */
  endOfStream(error?: EndOfStreamError): void {
    this.#ms.endOfStream(error);
  }

  /**
   * Update the seekable range for live streams. Should be called on every
   * pump tick while the stream is live.
   *
   * Arguments are **wall-clock epoch seconds**. Translates to player-time
   * (video.currentTime space) by subtracting wallAnchor before calling the
   * underlying MediaSource.setLiveSeekableRange.
   */
  setLiveSeekableRange(wallStart: number, wallEnd: number): void {
    this.#ms.setLiveSeekableRange(wallStart - this.wallAnchor, wallEnd - this.wallAnchor);
  }
}
