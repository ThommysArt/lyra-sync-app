import type { LyraEnvelope, PeerEndpoint } from "@lyra-sync-app/protocol";
import type { ProbeResult } from "./types.js";
import { LYRA_DEFAULT_TIMEOUT, type PeerTransport } from "./transport.js";

/**
 * NativeTcpTransport — mobile path via `react-native-tcp-socket`.
 * Falls back to fetch when running on web or when the native module is absent.
 *
 * Timeout is applied *after* slot acquisition (slot queue not implemented yet — placeholder).
 * Structure is timeout-after-slot:
 *   1. acquire slot (stub — immediate)
 *   2. start timeout
 *   3. perform probe/send
 *   4. release slot
 *
 * When `react-native-tcp-socket` is not installed, we catch the dynamic import
 * error and fallback to fetch (HTTP) so the transport remains usable in dev/web.
 */
export class NativeTcpTransport implements PeerTransport {
  private fallbackFetch(
    endpoint: PeerEndpoint,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const scheme = endpoint.preferHttps ? "https" : "http";
    const url = `${scheme}://${endpoint.host}:${endpoint.port}${path}`;
    return fetch(url, init);
  }

  async info(
    endpoint: PeerEndpoint,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ProbeResult> {
    const timeoutMs = opts?.timeoutMs ?? LYRA_DEFAULT_TIMEOUT;
    // Acquire slot (stub) — timeout starts after slot acquired
    const signal = opts?.signal;
    const start = Date.now();
    // try dynamic import of react-native-tcp-socket if available
    try {
      const mod = await tryLoadTcpSocket();
      if (mod) {
        // stub: if tcp socket available, we would do raw TCP probe.
        // For scaffold we still use HTTP probe over TCP socket tunnel.
        // Fall through to fetch fallback with structured timeout.
        void mod;
      }
    } catch {
      // ignore — fallback to fetch
    }
    // fetch fallback — timeout after slot
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
    }
    ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    try {
      const res = await this.fallbackFetch(endpoint, "/lyra/info", {
        method: "GET",
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      const latencyMs = Date.now() - start;
      clearTimeout(timer);
      if (!res.ok) return { ok: false, host: endpoint.host, port: endpoint.port, online: false, error: `http ${res.status}`, latencyMs };
      const data = (await res.json()) as Record<string, unknown>;
      return {
        ok: true,
        host: endpoint.host,
        port: endpoint.port,
        online: true,
        name: typeof data["name"] === "string" ? (data["name"] as string) : undefined,
        fingerprint: typeof data["fingerprint"] === "string" ? (data["fingerprint"] as string) : undefined,
        platform: typeof data["platform"] === "string" ? (data["platform"] as string) : undefined,
        latencyMs,
      };
    } catch (err) {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, host: endpoint.host, port: endpoint.port, online: false, error: message, latencyMs };
    }
  }

  async send(
    endpoint: PeerEndpoint,
    envelope: LyraEnvelope,
    opts?: { signal?: AbortSignal; timeoutMs?: number; sessionToken?: string },
  ): Promise<{ ok: true; envelope?: LyraEnvelope } | { ok: false; error: string }> {
    const timeoutMs = opts?.timeoutMs ?? LYRA_DEFAULT_TIMEOUT;
    // Slot acquired -> start timeout (structured for future queue)
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (opts?.sessionToken) headers["x-lyra-token"] = opts.sessionToken;

    try {
      const mod = await tryLoadTcpSocket();
      if (mod) {
        void mod;
        // future: write via socket, await response with timeout after slot
      }
    } catch {
      // ignore — fallback to fetch
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    if (opts?.signal) {
      if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", () => ctrl.abort(opts.signal?.reason), { once: true });
    }
    ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

    try {
      const res = await this.fallbackFetch(endpoint, "/lyra/message", {
        method: "POST",
        signal: ctrl.signal,
        headers,
        body: JSON.stringify(envelope),
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `http ${res.status} ${text}`.trim() };
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const data = (await res.json()) as LyraEnvelope;
        return { ok: true, envelope: data };
      }
      return { ok: true };
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async uploadChunk(
    endpoint: PeerEndpoint,
    transferId: string,
    offset: number,
    bytes: Uint8Array,
    opts?: { signal?: AbortSignal; timeoutMs?: number; sessionToken?: string },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    if (opts?.signal) {
      if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", () => ctrl.abort(opts.signal?.reason), { once: true });
    }
    ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    try {
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "x-transfer-id": transferId,
        "x-offset": String(offset),
      };
      if (opts?.sessionToken) headers["x-lyra-token"] = opts.sessionToken;
      const res = await this.fallbackFetch(endpoint, `/lyra/file/chunk?transferId=${encodeURIComponent(transferId)}&offset=${offset}`, {
        method: "POST",
        signal: ctrl.signal,
        headers,
        body: bytes as unknown as never,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `http ${res.status} ${text}`.trim() };
      }
      return { ok: true };
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }
}

async function tryLoadTcpSocket(): Promise<unknown | null> {
  try {
    // dynamic import — bundlers will handle missing module at runtime; try/catch ensures fallback to fetch
    const mod = await import("react-native-tcp-socket" as string);
    return (mod as unknown) ?? null;
  } catch {
    return null;
  }
}
