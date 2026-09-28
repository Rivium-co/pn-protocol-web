import { PNBackoff, PNFailures, PNEndpointRotation, PNConnectGuard } from '../src/PNReconnect';
import { pnEndpoint, pnEndpointUrl, pnEndpointEquals, normalizeWsPath } from '../src/PNEndpoint';
import { PNConfigBuilder } from '../src/PNConfig';

describe('PNBackoff', () => {
  it('starts at the base delay and doubles', () => {
    expect(PNBackoff.delay(0, 1000, 60000, 0.5)).toBe(1000);
    expect(PNBackoff.delay(1, 1000, 60000, 0.5)).toBe(2000);
    expect(PNBackoff.delay(5, 1000, 60000, 0.5)).toBe(32000);
  });

  it('caps at 60 s before jitter', () => {
    expect(PNBackoff.delay(6, 1000, 60000, 0.5)).toBe(60000);
    expect(PNBackoff.delay(50, 1000, 60000, 0.5)).toBe(60000);
    expect(PNBackoff.delay(10_000, 1000, 60000, 0.5)).toBe(60000);
  });

  it('applies ±20 % jitter', () => {
    expect(PNBackoff.delay(0, 1000, 60000, 0)).toBe(800);
    expect(PNBackoff.delay(0, 1000, 60000, 1)).toBe(1200);
    expect(PNBackoff.delay(20, 1000, 60000, 0)).toBe(48000);
    expect(PNBackoff.delay(20, 1000, 60000, 1)).toBe(72000);
    for (let i = 0; i < 200; i++) {
      const d = PNBackoff.delay(i % 40, 1000, 60000, Math.random());
      expect(d).toBeGreaterThanOrEqual(800);
      expect(d).toBeLessThanOrEqual(72000);
    }
  });

  it('clamps odd inputs', () => {
    expect(PNBackoff.delay(-3, 1000, 60000, 0.5)).toBe(1000);
    expect(PNBackoff.delay(0, 1000, 60000, 7)).toBe(1200);
    expect(PNBackoff.delay(0, -5, -5, 0.5)).toBe(0);
  });
});

describe('PNConfigBuilder defaults', () => {
  it('uses 30 s keepalive, 1 s..60 s backoff and never gives up', () => {
    const c = new PNConfigBuilder().gateway('gw').clientId('c').build();
    expect(c.heartbeatInterval).toBe(30);
    expect(c.reconnectDelay).toBe(1000);
    expect(c.maxReconnectDelay).toBe(60000);
    expect(c.maxReconnectAttempts).toBe(0);
    expect(c.wsPath).toBe('/mqtt');
    expect(c.secure).toBe(true);
  });
});

describe('PNFailures.isRejectedByBroker', () => {
  it('recognises CONNACK rejections', () => {
    expect(PNFailures.isRejectedByBroker({ message: 'Connection refused: Not authorized', code: 135 })).toBe(true);
    expect(PNFailures.isRejectedByBroker({ message: 'Connection refused: Bad User Name or Password', code: 134 })).toBe(true);
    expect(PNFailures.isRejectedByBroker({ message: 'Connection refused: Client Identifier not valid', code: 133 })).toBe(true);
    expect(PNFailures.isRejectedByBroker(new Error('Connection refused: Not authorized'))).toBe(true);
  });

  it('treats network failures as retryable elsewhere', () => {
    expect(PNFailures.isRejectedByBroker(new Error('WebSocket connection failed'))).toBe(false);
    expect(PNFailures.isRejectedByBroker({ message: 'Connection refused: Server unavailable', code: 136 })).toBe(false);
    expect(PNFailures.isRejectedByBroker({ message: 'ECONNREFUSED', code: 'ECONNREFUSED' })).toBe(false);
    expect(PNFailures.isRejectedByBroker(null)).toBe(false);
    expect(PNFailures.isRejectedByBroker(undefined)).toBe(false);
  });
});

describe('PNEndpoint', () => {
  it('builds ws/wss URLs with a path', () => {
    expect(pnEndpointUrl(pnEndpoint('a.example', 443))).toBe('wss://a.example:443/mqtt');
    expect(pnEndpointUrl(pnEndpoint('a.example', 8083, false, 'ws'))).toBe('ws://a.example:8083/ws');
    expect(normalizeWsPath('')).toBe('/mqtt');
    expect(normalizeWsPath(undefined)).toBe('/mqtt');
  });

  it('compares endpoints', () => {
    expect(pnEndpointEquals(pnEndpoint('A.example', 443), pnEndpoint('a.example', 443, true, '/mqtt'))).toBe(true);
    expect(pnEndpointEquals(pnEndpoint('a.example', 443), pnEndpoint('a.example', 443, false))).toBe(false);
    expect(pnEndpointEquals(pnEndpoint('a.example', 443), pnEndpoint('a.example', 443, true, '/x'))).toBe(false);
  });
});

describe('PNEndpointRotation', () => {
  const a = pnEndpoint('a', 443);
  const b = pnEndpoint('b', 443);
  const c = pnEndpoint('c', 443);

  it('moves to the next endpoint on a network failure, then ends the round', () => {
    const r = new PNEndpointRotation();
    r.startRound([a, b, a, c]);
    expect(r.size()).toBe(3);
    expect(r.current()).toEqual(a);
    expect(r.onConnectFailure(false)).toBe(true);
    expect(r.current()).toEqual(b);
    expect(r.onConnectFailure(false)).toBe(true);
    expect(r.current()).toEqual(c);
    expect(r.onConnectFailure(false)).toBe(false);
    expect(r.inRound()).toBe(false);
  });

  it('does not fail over when the broker rejected us', () => {
    const r = new PNEndpointRotation();
    r.startRound([a, b]);
    expect(r.onConnectFailure(true)).toBe(false);
    expect(r.inRound()).toBe(false);
  });

  it('returns the winner', () => {
    const r = new PNEndpointRotation();
    r.startRound([a, b]);
    r.onConnectFailure(false);
    expect(r.onConnected()).toEqual(b);
    expect(r.inRound()).toBe(false);
  });
});

describe('PNConnectGuard', () => {
  it('allows one attempt at a time and marks abandoned ones stale', () => {
    const g = new PNConnectGuard();
    const first = g.tryBegin();
    expect(first).not.toBeNull();
    expect(g.tryBegin()).toBeNull();
    g.invalidate();
    expect(g.isCurrent(first!)).toBe(false);
    expect(g.finish(first!)).toBe(false);
    const second = g.tryBegin();
    expect(second).not.toBeNull();
    expect(g.finish(second!)).toBe(true);
  });
});
