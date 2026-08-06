import type { LyraEnvelope, PeerEndpoint } from "@lyra-sync-app/protocol";
import type { ProbeResult } from "./types.js";
import { LYRA_DEFAULT_TIMEOUT, type PeerTransport } from "./transport.js";

function endpointBase(endpoint: PeerEndpoint): string {
  const scheme = endpoint.preferHttps ? "https" : "http";
  return `${scheme}://${endpoint.host}:${endpoint.port}`;
}

function timeoutSignal(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => {
    clearTimeout(timer);
    ctrl.abort(outer?.reason);
  };
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  // cleanup timer when ctrl aborts naturally
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

export class NodeHttpTransport implements PeerTransport {
  async info(
    endpoint: PeerEndpoint,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ProbeResult> {
    const timeoutMs = opts?.timeoutMs ?? LYRA_DEFAULT_TIMEOUT;
    const signal = timeoutSignal(timeoutMs, opts?.signal);
    const start = Date.now();
    const url = `${endpointBase(endpoint)}/lyra/info`;
    try {
      const res = await fetch(url, { method: "GET", signal, headers: { accept: "application/json" } });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        return { ok: false, host: endpoint.host, port: endpoint.port, online: false, error: `http ${res.status}`, latencyMs };
      }
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
    const signal = timeoutSignal(timeoutMs, opts?.signal);
    const url = `${endpointBase(endpoint)}/lyra/message`;
    try {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (opts?.sessionToken) headers["x-lyra-token"] = opts.sessionToken;
      const res = await fetch(url, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(envelope),
      });
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
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }
}
