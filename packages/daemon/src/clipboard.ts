/**
 * Clipboard monitor — polls electron.clipboard (or headless stub) and invokes onText when changed.
 * Works headless for tests: falls back to no-op interval that never fires if clipboard unavailable.
 */

export type ClipboardMonitorOpts = {
  intervalMs?: number;
  onText: (text: string) => void;
  getEnabled: () => boolean;
};

export type ClipboardMonitorHandle = {
  stop: () => void;
  isRunning: () => boolean;
};

type ElectronClipboard = {
  clipboard: {
    readText: (type?: string) => string;
    writeText: (text: string, type?: string) => void;
    readImage?: () => { toDataURL?: () => string; isEmpty?: () => boolean };
  };
};

function tryGetElectronClipboard(): ElectronClipboard["clipboard"] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as ElectronClipboard | { clipboard?: ElectronClipboard["clipboard"] };
    if (electron && typeof (electron as ElectronClipboard).clipboard?.readText === "function") return (electron as ElectronClipboard).clipboard;
    // try again via electron module's clipboard property
    // some electron versions expose clipboard directly
    const mod = electron as unknown as { clipboard?: ElectronClipboard["clipboard"] };
    if (typeof mod.clipboard?.readText === "function") return mod.clipboard;
  } catch {}
  return null;
}

let inMemoryClipboard = "";

export function readClipboardText(): string {
  const ec = tryGetElectronClipboard();
  if (ec) {
    try {
      return ec.readText();
    } catch {
      return inMemoryClipboard;
    }
  }
  return inMemoryClipboard;
}

export function writeClipboardText(text: string): void {
  inMemoryClipboard = text;
  const ec = tryGetElectronClipboard();
  if (ec) {
    try {
      ec.writeText(text);
    } catch {}
  }
}

export function startClipboardMonitor(opts: ClipboardMonitorOpts): ClipboardMonitorHandle {
  const intervalMs = Math.max(100, opts.intervalMs ?? 800);
  let last = "";
  // initialize last with current contents to avoid firing on start
  try {
    last = readClipboardText();
  } catch {
    last = "";
  }
  let running = true;
  const timer = setInterval(() => {
    if (!running) return;
    try {
      if (!opts.getEnabled()) return;
      const cur = readClipboardText();
      if (typeof cur === "string" && cur.length > 0 && cur !== last) {
        last = cur;
        opts.onText(cur);
      } else if (cur === "" && last !== "") {
        // keep last as ""? track empty as well but avoid spam
        last = cur;
      }
    } catch {
      // ignore
    }
  }, intervalMs);
  // don't block Node exit (for headless tests)
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return {
    stop: () => {
      running = false;
      clearInterval(timer);
    },
    isRunning: () => running,
  };
}

/**
 * iOS note: iOS cannot monitor automatically — use Send Clipboard manual button.
 * This is documented for mobile consumers; startClipboardMonitor will simply no-op on iOS
 * where electron is unavailable and inMemoryClipboard is used. Mobile should call
 * writeClipboardText/readClipboardText via expo-clipboard "Read system" button.
 */
export const IOS_CLIPBOARD_NOTE = "iOS cannot monitor automatically — use Send Clipboard";
