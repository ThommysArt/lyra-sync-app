/**
 * Structured logger for Lyra peer/transfer.
 * JSON lines to stdout/stderr for terminal visibility, with correlation IDs.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = (process.env.LYRA_LOG as LogLevel) || "info";

export function setLogLevel(lvl: LogLevel) {
  currentLevel = lvl;
}
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(lvl: LogLevel): boolean {
  return LEVEL_ORDER[lvl] >= LEVEL_ORDER[currentLevel];
}

function fmt(level: LogLevel, ns: string, msg: string, fields?: Record<string, unknown>) {
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString(),
    lvl: level,
    ns,
    msg,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) rec[k] = v;
    }
  }
  return JSON.stringify(rec);
}

let persistentLogQueue: string[] = [];
let persistentLogFlushing = false;
async function loadExpoFSForLogger(): Promise<unknown> {
  try {
    const gReq = (globalThis as unknown as { require?: (id: string) => unknown }).require;
    if (typeof gReq === "function") {
      try {
        const m = gReq("expo-file-system");
        if (m) return m;
      } catch {}
    }
  } catch {}
  try {
    const reqFn = new Function('return typeof require !== "undefined" ? require : null') as () => ((id: string) => unknown) | null;
    const req2 = reqFn();
    if (typeof req2 === "function") {
      try {
        const m = req2("expo-file-system");
        if (m) return m;
      } catch {}
    }
  } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const m = await (new Function('return import("expo-file-system")') as () => Promise<unknown>)().catch(() => null);
    if (m) return m;
  } catch {}
  try {
    // Direct import — works on native (Metro), on web resolved to stub via vite alias
    // @ts-ignore
    const m = await import("expo-file-system");
    return m;
  } catch {}
  return null;
}
async function loadExpoFSLegacyForLogger(): Promise<unknown> {
  try {
    const gReq = (globalThis as unknown as { require?: (id: string) => unknown }).require;
    if (typeof gReq === "function") {
      try {
        const m = gReq("expo-file-system/legacy");
        if (m) return m;
      } catch {}
    }
  } catch {}
  try {
    const reqFn = new Function('return typeof require !== "undefined" ? require : null') as () => ((id: string) => unknown) | null;
    const req2 = reqFn();
    if (typeof req2 === "function") {
      try {
        const m = req2("expo-file-system/legacy");
        if (m) return m;
      } catch {}
    }
  } catch {}
  try {
    const m = await (new Function('return import("expo-file-system/legacy")') as () => Promise<unknown>)().catch(() => null);
    if (m) return m;
  } catch {}
  try {
    // @ts-ignore
    const m = await import("expo-file-system/legacy");
    return m;
  } catch {}
  return null;
}
async function flushPersistentLog() {
  if (persistentLogFlushing) return;
  persistentLogFlushing = true;
  try {
    let mod: unknown = await loadExpoFSForLogger();
    const FileCls = (mod as unknown as { File?: new (...a: unknown[]) => { write: (c: string, o?: unknown) => void; exists: boolean; create: (o?: unknown) => void; uri: string } } | null)?.File;
    const PathsMod = (mod as unknown as { Paths?: { cache?: { uri: string } } } | null)?.Paths;
    if (!FileCls || !PathsMod?.cache) {
      persistentLogQueue = [];
      return;
    }
    if (persistentLogQueue.length === 0) return;
    const lines = persistentLogQueue.splice(0, 100).join("\n") + "\n";
    try {
      const logFile = new FileCls(PathsMod.cache, "lyra-debug.log");
      if (!logFile.exists) logFile.create({ intermediates: true } as unknown as never);
      // Check size and rotate if >2MB
      try {
        const info = (logFile as unknown as { info: () => { size?: number } }).info();
        if ((info.size ?? 0) > 2 * 1024 * 1024) {
          // Rotate: delete and recreate
          try { (logFile as unknown as { delete: () => void }).delete(); } catch {}
          logFile.create({ intermediates: true } as unknown as never);
        }
      } catch {}
      // Append
      try {
        (logFile as unknown as { write: (c: string, o?: unknown) => void }).write(lines, { append: true });
      } catch {
        // Fallback: try legacy
        try {
          const legacy: unknown = await loadExpoFSLegacyForLogger();
          const LS = legacy as unknown as { writeAsStringAsync?: (uri: string, s: string, o: unknown) => Promise<void>; EncodingType?: { UTF8: string }; getInfoAsync?: (uri: string) => Promise<{ exists: boolean }> } | null;
          if (LS?.writeAsStringAsync && (logFile as unknown as { uri?: string }).uri) {
            // We can't append via legacy easily; just ignore
          }
        } catch {}
      }
    } catch {}
    if (persistentLogQueue.length > 0) {
      // More queued while we were flushing
      setTimeout(() => void flushPersistentLog(), 100);
    }
  } finally {
    persistentLogFlushing = false;
  }
}

function isReactNativeEnv(): boolean {
  try {
    const g = globalThis as unknown as { navigator?: { product?: string } };
    if (g.navigator?.product === "ReactNative") return true;
  } catch {}
  return false;
}

function emit(level: LogLevel, ns: string, msg: string, fields?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const line = fmt(level, ns, msg, fields);
  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
  // Persist to file on mobile for post-crash diagnostics (20MB+ crash leaves no logcat)
  if (isReactNativeEnv()) {
    persistentLogQueue.push(line);
    if (persistentLogQueue.length >= 5 || level === "error" || level === "warn") {
      void flushPersistentLog();
    } else if (persistentLogQueue.length === 1) {
      setTimeout(() => void flushPersistentLog(), 800);
    }
  }
  // Also forward to Electron main log when available (desktop)
  try {
    const g = globalThis as unknown as { window?: { lyraDesktop?: { log?: (l: string, n: string, m: string, d?: unknown) => Promise<unknown> } }; lyraDesktop?: { log?: (l: string, n: string, m: string, d?: unknown) => Promise<unknown> } };
    const fn = g.window?.lyraDesktop?.log ?? g.lyraDesktop?.log;
    if (fn) void fn(level, ns, msg, fields);
  } catch {}
}

export function createLogger(ns: string) {
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", ns, msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => emit("info", ns, msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", ns, msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit("error", ns, msg, fields),
  };
}

export const lyraPeerLogger = createLogger("lyra:peer");
export const lyraTransferLogger = createLogger("lyra:transfer");
export const lyraSealLogger = createLogger("lyra:seal");
export const lyraDiscoveryLogger = createLogger("lyra:discovery");
