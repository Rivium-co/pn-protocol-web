/**
 * One gateway address PNSocket can connect to (MQTT over WebSocket).
 */
export interface PNEndpoint {
  /** Gateway host name */
  host: string;
  /** Gateway port (1..65535) */
  port: number;
  /** Use a secure WebSocket (wss://) when true, ws:// otherwise */
  secure: boolean;
  /** WebSocket path, e.g. `/mqtt` */
  path: string;
}

/** Default WebSocket path. */
export const PN_DEFAULT_WS_PATH = '/mqtt';

/** Normalise a WebSocket path: empty -> default, always a leading slash. */
export function normalizeWsPath(path?: string | null): string {
  const trimmed = (path ?? '').trim();
  if (!trimmed) return PN_DEFAULT_WS_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Build a PNEndpoint, normalising the path. */
export function pnEndpoint(host: string, port: number, secure = true, path?: string): PNEndpoint {
  return { host, port, secure, path: normalizeWsPath(path) };
}

/** Connection URL of an endpoint, e.g. `wss://host:443/mqtt`. */
export function pnEndpointUrl(endpoint: PNEndpoint): string {
  return `${endpoint.secure ? 'wss' : 'ws'}://${endpoint.host}:${endpoint.port}${normalizeWsPath(endpoint.path)}`;
}

/** True when both endpoints address the same gateway. */
export function pnEndpointEquals(a: PNEndpoint | null | undefined, b: PNEndpoint | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.port === b.port &&
    a.secure === b.secure &&
    normalizeWsPath(a.path) === normalizeWsPath(b.path)
  );
}

/**
 * Supplies the endpoints to try, in order, at the start of every connection round.
 * The first endpoint that accepts the connection wins; on a network failure
 * (timeout, refused, closed before CONNACK) PNSocket moves on to the next one.
 * An empty list means "use the gateway/port/secure/wsPath from PNConfig".
 */
export type PNEndpointProvider = () => PNEndpoint[];

/** Notified with the endpoint a connection was established on. */
export type PNEndpointListener = (endpoint: PNEndpoint) => void;
