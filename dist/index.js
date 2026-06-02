var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};

// src/managed-source-buffer.ts
var ManagedSourceBuffer = class {
  constructor(sourceBuffer) {
    __publicField(this, "sourceBuffer");
    __publicField(this, "queue", []);
    __publicField(this, "isProcessing", false);
    this.sourceBuffer = sourceBuffer;
  }
  /**
   * Append bytes. Queued if another operation is in progress.
   */
  async append(data) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        kind: "append",
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
  async remove(start, end) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        kind: "remove",
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
  async abort() {
    return new Promise((resolve, reject) => {
      this.queue.push({
        kind: "abort",
        args: [],
        resolve,
        reject
      });
      this.processQueue();
    });
  }
  /**
   * Synchronous. Change the MIME+codecs type of the underlying SourceBuffer.
   * Call before the next append when a codec switch is needed.
   * Throws if the browser does not support SourceBuffer.changeType().
   */
  changeType(type) {
    this.sourceBuffer.changeType(type);
  }
  /**
   * True while an async operation is in progress.
   */
  get updating() {
    return this.sourceBuffer.updating;
  }
  /**
   * Live TimeRanges from the underlying SourceBuffer.
   */
  get buffered() {
    return this.sourceBuffer.buffered;
  }
  processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }
    this.isProcessing = true;
    const operation = this.queue[0];
    const resolve = () => {
      operation.resolve();
      this.queue.shift();
      this.isProcessing = false;
      this.processQueue();
    };
    const reject = (error) => {
      operation.reject(error);
      this.queue.shift();
      this.isProcessing = false;
      this.processQueue();
    };
    try {
      switch (operation.kind) {
        case "append":
          this.sourceBuffer.addEventListener("updateend", resolve);
          this.sourceBuffer.addEventListener("error", (event) => {
            const error = new Error("SourceBuffer error occurred");
            reject(error);
          });
          this.sourceBuffer.appendBuffer(operation.args[0]);
          break;
        case "remove":
          this.sourceBuffer.addEventListener("updateend", resolve);
          this.sourceBuffer.addEventListener("error", (event) => {
            const error = new Error("SourceBuffer error occurred");
            reject(error);
          });
          this.sourceBuffer.remove(operation.args[0], operation.args[1]);
          break;
        case "abort":
          this.sourceBuffer.addEventListener("updateend", resolve);
          this.sourceBuffer.addEventListener("error", (event) => {
            const error = new Error("SourceBuffer error occurred");
            reject(error);
          });
          this.sourceBuffer.abort();
          break;
      }
    } catch (error) {
      reject(error);
    }
  }
};
export {
  ManagedSourceBuffer
};
