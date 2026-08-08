/**
 * Pluggable HTTP transport for peer-client.
 * React Native can inject a TCP-socket implementation when fetch(POST) to
 * cleartext LAN/Tailscale peers is unreliable.
 *
 * Transport is stored on globalThis so monorepo/Metro duplicate module
 * instances of @lyra-sync-app/net still share the same client.
 */

export type HttpRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  lane?: number;
};

export type HttpResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

export type HttpTransport = (
  url: string,
  init?: HttpRequestInit,
) => Promise<HttpResponse>;

const GLOBAL_KEY = "__lyra_http_transport_v1__";

type GlobalBag = typeof globalThis & {
  [GLOBAL_KEY]?: HttpTransport | null;
};

function readGlobal(): HttpTransport | null | undefined {
  try {
    return (globalThis as GlobalBag)[GLOBAL_KEY];
  } catch {
    return undefined;
  }
}

function writeGlobal(transport: HttpTransport | null): void {
  try {
    (globalThis as GlobalBag)[GLOBAL_KEY] = transport;
  } catch {}
}

let customTransport: HttpTransport | null = null;

export function setHttpTransport(transport: HttpTransport | null): void {
  customTransport = transport;
  writeGlobal(transport);
}

export function getHttpTransport(): HttpTransport {
  if (customTransport) return customTransport;
  const g = readGlobal();
  if (g) return g;
  return fetchAsTransport;
}

export function hasCustomHttpTransport(): boolean {
  return Boolean(customTransport || readGlobal());
}

function forwardLog(level: string, ns: string, msg: string, data?: unknown) {
  const line = `[${ns}] ${msg}` + (data ? ` ${typeof data === "string" ? data : JSON.stringify(data).slice(0,800)}` : "");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  try {
    const g = globalThis as unknown as { window?: { lyraDesktop?: { log?: (l: string, n: string, m: string, d?: unknown) => Promise<unknown> } }; lyraDesktop?: { log?: (l: string, n: string, m: string, d?: unknown) => Promise<unknown> } };
    const fn = g.window?.lyraDesktop?.log ?? g.lyraDesktop?.log;
    if (fn) void fn(level, ns, msg, data);
  } catch {}
}

export async function fetchAsTransport(
  url: string,
  init?: HttpRequestInit,
): Promise<HttpResponse> {
  const timeoutMs =
    typeof init?.timeoutMs === "number" && init.timeoutMs > 0 ? init.timeoutMs : undefined;
  const controller = timeoutMs ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = () => controller?.abort();

  if (controller) {
    if (init?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (init?.signal) {
      init.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const headers = { ...(init?.headers ?? {}) } as Record<string, string>;
    const lowerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    if (!lowerKeys.includes("connection")) headers["connection"] = "keep-alive";
    const fetchOpts: RequestInit & { keepalive?: boolean; dispatcher?: unknown } = {
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
      signal: controller?.signal ?? init?.signal,
      cache: "no-store" as RequestCache,
      keepalive: true,
    };
    // undici is Node-only; avoid vite bundling it for web by using dynamic eval
    try {
      const dynRequire = Function('return typeof require !== "undefined" ? require : null')() as unknown as ((id: string) => unknown) | null;
      const undici = dynRequire ? (dynRequire("undici") as { Agent?: new (o: unknown) => unknown }) : null;
      if (undici?.Agent && typeof (fetchOpts as unknown as Record<string, unknown>).dispatcher === "undefined") {
        const g = globalThis as unknown as { __lyraUndiciAgent?: unknown };
        if (!g.__lyraUndiciAgent) {
          g.__lyraUndiciAgent = new undici.Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 16 });
        }
        (fetchOpts as unknown as Record<string, unknown>).dispatcher = g.__lyraUndiciAgent;
      }
    } catch {}
    let res: Response;
    try {
      res = await fetch(url, fetchOpts as RequestInit);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isProbe = init?.lane === 2 || (url.includes("/lyra/info") && init?.method !== "POST");
      const isCanceled = /canceled|cancelled|abort/i.test(msg);
      // Discovery probes are expected to fail for most hosts in /24 — don't spam logs
      if (isProbe && isCanceled) {
        // Silent for probe cancel — caller will handle summary
        throw e;
      }
      if (isProbe) {
        // For probe GETs, log at debug level only (throttled)
        // Use console.debug to avoid WS HMR flood, and don't forward to main
        if (typeof console.debug === "function") console.debug(`[lyra http] probe failed ${init?.method ?? "GET"} ${url}: ${msg}`);
        throw e;
      }
      forwardLog("error", "lyra http", `fetch failed ${init?.method ?? "GET"} ${url}: ${msg}`, { url, method: init?.method, error: msg, stack: e instanceof Error ? e.stack?.slice(0,500) : undefined });
      throw e;
    }
    if (!res.ok) {
      forwardLog("warn", "lyra http", `${init?.method ?? "GET"} ${url} -> HTTP ${res.status}`, { url, method: init?.method, status: res.status });
    } else {
      // Log successful POSTs for transfers at debug level (visible when LYRA_LOG=debug)
      if (init?.method === "POST" && url.includes("/lyra/message")) {
        forwardLog("log", "lyra http", `POST ${url} -> ${res.status}`, { url });
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      text: () => res.text(),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (init?.signal && controller) {
      try {
        init.signal.removeEventListener("abort", onExternalAbort);
      } catch {}
    }
  }
}
