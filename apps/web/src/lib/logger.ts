/**
 * Forward logs from renderer to Electron main terminal via IPC.
 * Falls back to console if not in Electron.
 */
export function forwardLog(level: "log" | "info" | "warn" | "error", ns: string, msg: string, data?: unknown) {
  const line = `[${ns}] ${msg}` + (data ? ` ${typeof data === "string" ? data : JSON.stringify(data).slice(0,800)}` : "");
  if (level === "error") console.error(line, data ?? "");
  else if (level === "warn") console.warn(line, data ?? "");
  else console.log(line, data ?? "");

  // Forward to main process terminal via IPC (Electron)
  try {
    const w = globalThis as unknown as { window?: { lyraDesktop?: { log?: (level: string, ns: string, msg: string, data?: unknown) => Promise<unknown> } } };
    const logFn = w.window?.lyraDesktop?.log ?? (globalThis as unknown as { lyraDesktop?: { log?: (level: string, ns: string, msg: string, data?: unknown) => Promise<unknown> } }).lyraDesktop?.log;
    if (logFn) {
      // Fire-and-forget, don't await
      void logFn(level, ns, msg, data);
    }
    // Also try global window
    const gLog = (globalThis as unknown as { lyraDesktop?: { log?: (level: string, ns: string, msg: string, data?: unknown) => Promise<unknown> } }).lyraDesktop?.log;
    if (gLog && !w.window?.lyraDesktop?.log) {
      void gLog(level, ns, msg, data);
    }
  } catch {}
}

export const logger = {
  log: (ns: string, msg: string, data?: unknown) => forwardLog("log", ns, msg, data),
  info: (ns: string, msg: string, data?: unknown) => forwardLog("info", ns, msg, data),
  warn: (ns: string, msg: string, data?: unknown) => forwardLog("warn", ns, msg, data),
  error: (ns: string, msg: string, data?: unknown) => forwardLog("error", ns, msg, data),
};
