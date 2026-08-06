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
  /**
   * Wall-clock budget for the request after the transport begins work.
   * Native TCP transport starts this *after* a concurrency slot is acquired so
   * LAN scan queue wait does not burn the timeout (critical for mobile discovery).
   * For pair long-polls, pass waitMs + buffer (e.g. 125_000).
   */
  timeoutMs?: number;
  /**
   * Priority lane for native TCP queue (0=pair, 1=interactive, 2=scan).
   * Defaults to interactive (1). Scan uses 2 so user actions preempt discovery.
   */
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
  } catch {
    // ignore
  }
}

let customTransport: HttpTransport | null = null;

/** Install a platform transport (e.g. RN TCP). Pass null to restore fetch. */
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

/** True when a custom (non-fetch) transport is installed. */
export function hasCustomHttpTransport(): boolean {
  return Boolean(customTransport || readGlobal());
}

async function fetchAsTransport(
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
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      signal: controller?.signal ?? init?.signal,
      cache: "no-store" as RequestCache,
    });
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
      } catch {
        // ignore
      }
    }
  }
}
