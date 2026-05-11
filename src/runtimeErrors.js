const MAX_RUNTIME_ERRORS = 100;
const runtimeErrors = [];
const listeners = new Set();
let installed = false;

function serializeErrorPart(part) {
  if (part instanceof Error) {
    return {
      name: part.name,
      message: part.message,
      stack: part.stack || ""
    };
  }

  if (part && typeof part === "object") {
    try {
      return JSON.parse(JSON.stringify(part, (_key, value) => {
        if (typeof value === "bigint") return value.toString();
        return value;
      }));
    } catch {
      return String(part);
    }
  }

  return String(part);
}

export function recordRuntimeError(source = "runtime", ...parts) {
  const entry = {
    id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: String(source || "runtime").slice(0, 120),
    createdAt: new Date().toISOString(),
    parts: parts.map(serializeErrorPart).slice(0, 8)
  };
  runtimeErrors.unshift(entry);
  runtimeErrors.splice(MAX_RUNTIME_ERRORS);
  for (const listener of listeners) {
    listener(entry);
  }
}

export function getRuntimeErrors() {
  return runtimeErrors.map((entry) => ({ ...entry, parts: [...entry.parts] }));
}

export function clearRuntimeErrors() {
  runtimeErrors.splice(0, runtimeErrors.length);
}

export function onRuntimeError(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installRuntimeErrorCapture() {
  if (installed) return;
  installed = true;

  const originalError = console.error.bind(console);
  console.error = (...args) => {
    recordRuntimeError("console.error", ...args);
    originalError(...args);
  };

  process.on("unhandledRejection", (reason) => {
    recordRuntimeError("unhandledRejection", reason);
    originalError("Unhandled rejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    recordRuntimeError("uncaughtException", error);
    originalError("Uncaught exception:", error);
    setImmediate(() => process.exit(1));
  });
}
