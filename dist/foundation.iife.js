var VidelFoundation = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __accessCheck = (obj, member, msg) => {
    if (!member.has(obj))
      throw TypeError("Cannot " + msg);
  };
  var __privateGet = (obj, member, getter) => {
    __accessCheck(obj, member, "read from private field");
    return getter ? getter.call(obj) : member.get(obj);
  };
  var __privateAdd = (obj, member, value) => {
    if (member.has(obj))
      throw TypeError("Cannot add the same private member more than once");
    member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
  };
  var __privateSet = (obj, member, value, setter) => {
    __accessCheck(obj, member, "write to private field");
    setter ? setter.call(obj, value) : member.set(obj, value);
    return value;
  };
  var __privateMethod = (obj, member, method) => {
    __accessCheck(obj, member, "access private method");
    return method;
  };

  // src/foundation.ts
  var foundation_exports = {};
  __export(foundation_exports, {
    ManagedSourceBuffer: () => ManagedSourceBuffer
  });

  // src/managed-source-buffer.ts
  var _sb, _queue, _current, _onUpdateEnd, _onError, _drain, drain_fn, _settle, settle_fn, _fail, fail_fn;
  var ManagedSourceBuffer = class {
    constructor(sourceBuffer) {
      // ── Private ────────────────────────────────────────────────────────────────
      __privateAdd(this, _drain);
      __privateAdd(this, _settle);
      __privateAdd(this, _fail);
      __privateAdd(this, _sb, void 0);
      __privateAdd(this, _queue, []);
      __privateAdd(this, _current, null);
      // Bound handlers — kept as fields so they can be removed.
      __privateAdd(this, _onUpdateEnd, void 0);
      __privateAdd(this, _onError, void 0);
      __privateSet(this, _sb, sourceBuffer);
      __privateSet(this, _onUpdateEnd, () => __privateMethod(this, _settle, settle_fn).call(this));
      __privateSet(this, _onError, (event) => __privateMethod(this, _fail, fail_fn).call(this, event));
      __privateGet(this, _sb).addEventListener("updateend", __privateGet(this, _onUpdateEnd));
      __privateGet(this, _sb).addEventListener("error", __privateGet(this, _onError));
    }
    /** Append bytes. Queued if another operation is in progress. */
    append(data) {
      return new Promise((resolve, reject) => {
        __privateGet(this, _queue).push({ kind: "append", args: [data], resolve, reject });
        __privateMethod(this, _drain, drain_fn).call(this);
      });
    }
    /** Remove buffered range [start, end) in seconds. Queued. */
    remove(start, end) {
      return new Promise((resolve, reject) => {
        __privateGet(this, _queue).push({ kind: "remove", args: [start, end], resolve, reject });
        __privateMethod(this, _drain, drain_fn).call(this);
      });
    }
    /**
     * Abort: immediately rejects all queued operations, calls sourceBuffer.abort(),
     * and resolves when the resulting updateend fires.
     */
    abort() {
      return new Promise((resolve, reject) => {
        for (const entry of __privateGet(this, _queue)) {
          entry.reject(new Error("ManagedSourceBuffer: aborted"));
        }
        __privateGet(this, _queue).length = 0;
        if (__privateGet(this, _current)) {
          __privateGet(this, _current).reject(new Error("ManagedSourceBuffer: aborted"));
          __privateSet(this, _current, null);
        }
        if (__privateGet(this, _sb).updating) {
          const onEnd = () => {
            __privateGet(this, _sb).removeEventListener("updateend", onEnd);
            resolve();
          };
          __privateGet(this, _sb).addEventListener("updateend", onEnd);
          __privateGet(this, _sb).abort();
        } else {
          resolve();
        }
      });
    }
    /**
     * Synchronous. Change the MIME+codecs type of the underlying SourceBuffer.
     * Throws if the browser does not support SourceBuffer.changeType().
     */
    changeType(type) {
      if (typeof __privateGet(this, _sb).changeType !== "function") {
        throw new Error("ManagedSourceBuffer: changeType() is not supported in this browser");
      }
      __privateGet(this, _sb).changeType(type);
    }
    /** True while an async operation is in progress. */
    get updating() {
      return __privateGet(this, _sb).updating;
    }
    /** Live TimeRanges from the underlying SourceBuffer. */
    get buffered() {
      return __privateGet(this, _sb).buffered;
    }
  };
  _sb = new WeakMap();
  _queue = new WeakMap();
  _current = new WeakMap();
  _onUpdateEnd = new WeakMap();
  _onError = new WeakMap();
  _drain = new WeakSet();
  drain_fn = function() {
    if (__privateGet(this, _current) !== null || __privateGet(this, _queue).length === 0)
      return;
    __privateSet(this, _current, __privateGet(this, _queue).shift());
    try {
      if (__privateGet(this, _current).kind === "append") {
        __privateGet(this, _sb).appendBuffer(__privateGet(this, _current).args[0]);
      } else {
        __privateGet(this, _sb).remove(__privateGet(this, _current).args[0], __privateGet(this, _current).args[1]);
      }
    } catch (err) {
      const entry = __privateGet(this, _current);
      __privateSet(this, _current, null);
      entry.reject(err instanceof Error ? err : new Error(String(err)));
      __privateMethod(this, _drain, drain_fn).call(this);
    }
  };
  _settle = new WeakSet();
  settle_fn = function() {
    if (!__privateGet(this, _current))
      return;
    const entry = __privateGet(this, _current);
    __privateSet(this, _current, null);
    entry.resolve();
    __privateMethod(this, _drain, drain_fn).call(this);
  };
  _fail = new WeakSet();
  fail_fn = function(event) {
    const entry = __privateGet(this, _current);
    __privateSet(this, _current, null);
    const error = new Error("ManagedSourceBuffer: SourceBuffer error");
    if (entry)
      entry.reject(error);
    for (const queued of __privateGet(this, _queue)) {
      queued.reject(error);
    }
    __privateGet(this, _queue).length = 0;
  };
  return __toCommonJS(foundation_exports);
})();
