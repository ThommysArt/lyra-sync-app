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
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const undici = typeof require !== "undefined" ? (require("undici") as { Agent?: new (o: unknown) => unknown }) : null;
      if (undici?.Agent && typeof (fetchOpts as any).dispatcher === "undefined") {
        const g = globalThis as unknown as { __lyraUndiciAgent?: unknown };
        if (!g.__lyraUndiciAgent) {
          g.__lyraUndiciAgent = new undici.Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 16 });
        }
        (fetchOpts as any).dispatcher = g.__lyraUndiciAgent;
      }
    } catch {}
    const res = await fetch(url, fetchOpts as RequestInit);
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
