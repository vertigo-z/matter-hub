const MAX_ENTRIES = 500;
class Log {
  #entries = [];
  #subscribers = /* @__PURE__ */ new Set();
  get entries() {
    return this.#entries;
  }
  push(level, source, message) {
    const entry = {
      t: Date.now(),
      level,
      source,
      message: typeof message === "string" ? message : JSON.stringify(message)
    };
    this.#entries.push(entry);
    if (this.#entries.length > MAX_ENTRIES) this.#entries.shift();
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(entry);
      } catch {
        this.#subscribers.delete(subscriber);
      }
    }
  }
  info(source, message) {
    this.push("info", source, message);
  }
  warn(source, message) {
    this.push("warn", source, message);
  }
  error(source, message) {
    this.push("error", source, message);
  }
  subscribe(subscriber) {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }
}
export {
  Log
};
//# sourceMappingURL=Log.js.map
