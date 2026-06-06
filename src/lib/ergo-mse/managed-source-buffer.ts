import type { ISourceBuffer } from './i-source-buffer';

/**
 * ManagedSourceBuffer is a promise-based wrapper around the browser's event-driven
 * SourceBuffer API. It serializes concurrent operations internally and surfaces
 * errors as rejected promises.
 *
 * Implements ISourceBuffer so it is interchangeable with TextSourceBuffer
 * throughout the element tree.
 */
export class ManagedSourceBuffer implements ISourceBuffer {
  private sourceBuffer: SourceBuffer;
  private queue: Array<{
    kind: 'append' | 'remove' | 'abort' | 'changeType';
    args: any[];
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private isProcessing = false;

  constructor(sourceBuffer: SourceBuffer) {
    this.sourceBuffer = sourceBuffer;
  }

  /**
   * Append bytes. Queued if another operation is in progress.
   */
  async append(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ kind: 'append', args: [data], resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Remove buffered range [start, end) in seconds. Queued.
   */
  async remove(start: number, end: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ kind: 'remove', args: [start, end], resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Abort the current operation; clears the pending queue; resolves when settled.
   */
  async abort(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startIdx = this.isProcessing ? 1 : 0;
      const drained  = this.queue.splice(startIdx);
      for (const op of drained) op.reject(new Error('Aborted'));

      if (!this.isProcessing) { resolve(); return; }

      this.queue.push({ kind: 'abort', args: [], resolve, reject });
    });
  }

  /**
   * Change the MIME+codecs type of the underlying SourceBuffer.
   * Throws if the browser does not support SourceBuffer.changeType().
   */
  changeType(type: string): void {
    this.sourceBuffer.changeType(type);
  }

  get updating(): boolean { return this.sourceBuffer.updating; }
  get buffered(): TimeRanges { return this.sourceBuffer.buffered; }

  /**
   * Offset (seconds) added to decoded media timestamps to produce presentation
   * times. Corresponds to SourceBuffer.timestampOffset.
   *
   * Set by videl-representation after the init segment is appended, using the
   * value stamped on the representation element by the MPD parser:
   *   timestampOffset = periodStart − presentationTimeOffset / timescale
   */
  get timestampOffset(): number { return this.sourceBuffer.timestampOffset; }
  set timestampOffset(v: number) { this.sourceBuffer.timestampOffset = v; }

  private processQueue(): void {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing  = true;
    const operation    = this.queue[0];

    const onSuccess = () => {
      this.sourceBuffer.removeEventListener('updateend', onSuccess);
      this.sourceBuffer.removeEventListener('error', onError);
      operation.resolve();
      this.queue.shift();
      this.isProcessing = false;
      this.processQueue();
    };

    const onError = () => {
      this.sourceBuffer.removeEventListener('updateend', onSuccess);
      this.sourceBuffer.removeEventListener('error', onError);
      const error = new Error('SourceBuffer error occurred');
      const ops   = this.queue.splice(0);
      this.isProcessing = false;
      for (const op of ops) op.reject(error);
    };

    try {
      switch (operation.kind) {
        case 'append':
          this.sourceBuffer.addEventListener('updateend', onSuccess);
          this.sourceBuffer.addEventListener('error', onError);
          this.sourceBuffer.appendBuffer(operation.args[0]);
          break;
        case 'remove':
          this.sourceBuffer.addEventListener('updateend', onSuccess);
          this.sourceBuffer.addEventListener('error', onError);
          this.sourceBuffer.remove(operation.args[0], operation.args[1]);
          break;
        case 'abort':
          if (this.sourceBuffer.updating) {
            this.sourceBuffer.addEventListener('updateend', onSuccess);
            this.sourceBuffer.addEventListener('error', onError);
            this.sourceBuffer.abort();
          } else {
            operation.resolve();
            this.queue.shift();
            this.isProcessing = false;
            this.processQueue();
          }
          break;
      }
    } catch (error) {
      this.sourceBuffer.removeEventListener('updateend', onSuccess);
      this.sourceBuffer.removeEventListener('error', onError);
      const ops = this.queue.splice(0);
      this.isProcessing = false;
      for (const op of ops) op.reject(error as Error);
    }
  }
}
