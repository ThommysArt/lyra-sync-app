/**
 * Pluggable HTTP transport for peer-client.
 * React Native can inject a TCP-socket implementation when fetch(POST) to
 * cleartext LAN/Tailscale peers is unreliable.
 */

export type HttpRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
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

let customTransport: HttpTransport | null = null;

/** Install a platform transport (e.g. RN TCP). Pass null to restore fetch. */
export function setHttpTransport(transport: HttpTransport | null): void {
  customTransport = transport;
}

export function getHttpTransport(): HttpTransport {
  if (customTransport) return customTransport;
  return fetchAsTransport;
}

async function fetchAsTransport(
  url: string,
  init?: HttpRequestInit,
): Promise<HttpResponse> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
    signal: init?.signal,
    cache: "no-store" as RequestCache,
  });
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  };
}
