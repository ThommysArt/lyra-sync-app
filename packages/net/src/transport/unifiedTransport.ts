/**
 * Unified Lyra Transport — pooled, keep-alive, priority-aware
 *
 * This module is the single transport abstraction used by both
 * desktop (Node undici) and mobile (react-native-tcp-socket).
 *
 * - Node/desktop: fetch with undici Agent (keepAlive 30s, 16 connections, http+https)
 * - Mobile: TCP-socket transport with priority lanes (PAIR > INTERACTIVE > SCAN)
 * - Unified API: HttpTransport via globalThis singleton so Metro duplicate copies share it
 * - Guarantees: lane-aware concurrency, timeout starts AFTER slot acquisition,
 *   no per-probe log spam, automatic TLS fallback (http ↔ https)
 *
 * The transport is intentionally thin — connection pooling and retry are
 * handled by ConnectionManager above.
 */

import {
  type HttpTransport,
  getHttpTransport,
  setHttpTransport,
  fetchAsTransport,
  type HttpRequestInit,
} from "../http-transport";
import { Lane } from "./priorityQueue";

export type UnifiedTransportOptions = {
  /** Prefer TCP socket on native (default true when available) */
  preferTcpOnNative?: boolean;
  /** Keep-alive timeout ms (Node only) */
  keepAliveMs?: number;
  /** Max connections per host */
  maxConnections?: number;
};

let installed: HttpTransport | null = null;

/**
 * Create a transport appropriate for current platform.
 * On React Native, tries to create TCP transport; falls back to fetch.
 * On Node/desktop, returns pooled fetch (undici).
 */
export function createUnifiedTransport(opts?: UnifiedTransportOptions): HttpTransport {
  const isReactNative = (() => {
    try {
      const g = globalThis as unknown as { navigator?: { product?: string } };
      if (g.navigator?.product === "ReactNative") return true;
      // @ts-ignore expo global
      if ((globalThis as unknown as { expo?: unknown }).expo) return true;
      // @ts-ignore Platform
      if ((globalThis as unknown as { Platform?: { OS?: string } }).Platform?.OS === "android") return true;
      if ((globalThis as unknown as { Platform?: { OS?: string } }).Platform?.OS === "ios") return true;
    } catch {}
    return false;
  })();

  if (isReactNative && opts?.preferTcpOnNative !== false) {
    // Dynamically import TCP transport to avoid bundling it on web/desktop
    try {
      // Use Function to avoid static analysis
      const reqFn = Function('return typeof require !== "undefined" ? require : null')() as unknown as ((id: string) => unknown) | null;
      if (reqFn) {
        try {
          // Try to load the native module; if it fails we fall back to fetch
          const mod = reqFn("@lyra-sync-app/native-tcp") as unknown;
          void mod;
        } catch {}
      }
    } catch {}
    // Actual TCP creation is done by apps/native/lib/tcp-http-client which calls
    // createTcpHttpTransport() and setHttpTransport. We keep fetch as fallback here
    // so Node/desktop tests still pass without native module.
    const existing = getHttpTransport();
    // If a custom transport is already set (e.g. TCP), honor it
    if (existing !== fetchAsTransport) return existing;
  }

  // Node/desktop pooled fetch — already has undici pooling inside fetchAsTransport
  // Wrap with priority-lane awareness for uniform API
  const pooled: HttpTransport = async (url, init?: HttpRequestInit) => {
    // Map caller lane to transport lane if provided, else default INTERACTIVE
    const lane = typeof init?.lane === "number" ? init.lane : Lane.INTERACTIVE;
    // Use global priority queue for SCAN throttling even on Node (prevents /24 floods)
    const { withPrioritySlot } = await import("./priorityQueue");
    return withPrioritySlot(() => fetchAsTransport(url, init), lane as never, init?.signal);
  };

  return pooled;
}

export function installUnifiedTransport(opts?: UnifiedTransportOptions): () => void {
  const transport = createUnifiedTransport(opts);
  // Only install if not already custom (preserve native TCP when present)
  const current = getHttpTransport();
  const isCustom = current !== fetchAsTransport;
  if (!isCustom) {
    setHttpTransport(transport);
    installed = transport;
    return () => {
      if (installed === transport) {
        setHttpTransport(null);
        installed = null;
      }
    };
  }
  // Already has TCP — just return no-op uninstall
  return () => {};
}

export function getUnifiedTransport(): HttpTransport {
  return getHttpTransport();
}

/** For tests: force install pooled fetch even on native */
export function forceInstallPooledFetch(): void {
  setHttpTransport(fetchAsTransport);
}
