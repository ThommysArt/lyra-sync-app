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

function emit(level: LogLevel, ns: string, msg: string, fields?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const line = fmt(level, ns, msg, fields);
  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
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
