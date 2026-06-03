/**
 * ManagedSourceBuffer is a promise-based wrapper around the browser's event-driven
 * SourceBuffer API. It serializes concurrent operations internally and surfaces
 * errors as rejected promises.
 */
export class ManagedSourceBuffer {
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
      this.queue.push({
        kind: 'append',
        args: [data],
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  /**
   * Remove buffered range [start, end) in seconds. Queued.
   */
  async remove(start: number, end: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        kind: 'remove',
        args: [start, end],
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  /**
   * Abort the current operation; clears the pending queue; resolves when settled.
   */
  async abort(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Immediately reject all queued-but-not-yet-started operations.
      const startIdx = this.isProcessing ? 1 : 0;
      const drained = this.queue.splice(startIdx);
      for (const op of drained) {
        op.reject(new Error('Aborted'));
      }

      if (!this.isProcessing) {
        // Nothing in flight — resolve straight away.
        resolve();
        return;
      }

      // An operation is in flight. Queue a sentinel that will resolve once it
      // finishes (processQueue will pick it up and handle the abort case).
      this.queue.push({ kind: 'abort', args: [], resolve, reject });
    });
  }

  /**
   * Synchronous. Change the MIME+codecs type of the underlying SourceBuffer.
   * Call before the next append when a codec switch is needed.
   * Throws if the browser does not support SourceBuffer.changeType().
   */
  changeType(type: string): void {
    this.sourceBuffer.changeType(type);
  }

  /**
   * True while an async operation is in progress.
   */
  get updating(): boolean {
    return this.sourceBuffer.updating;
  }

  /**
   * Live TimeRanges from the underlying SourceBuffer.
   */
  get buffered(): TimeRanges {
    return this.sourceBuffer.buffered;
  }

  private processQueue(): void {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const operation = this.queue[0];

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
      // Flush the entire queue — every pending op is rejected.
      const ops = this.queue.splice(0);
      this.isProcessing = false;
      for (const op of ops) {
        op.reject(error);
      }
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
          // By the time abort is dequeued, the in-flight op has already
          // finished, so sourceBuffer.updating is false. Just resolve.
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
      for (const op of ops) {
        op.reject(error as Error);
      }
    }
  }
}