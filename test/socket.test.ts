import { EventEmitter } from 'events';

class FakeClient extends EventEmitter {
  connected = false;
  ended = false;
  url: string;
  options: any;
  pings = 0;
  subscribe = jest.fn();
  unsubscribe = jest.fn();
  publish = jest.fn();
  constructor(url: string, options: any) {
    super();
    this.url = url;
    this.options = options;
  }
  end = jest.fn(() => {
    this.ended = true;
    this.connected = false;
    return this;
  });
  sendPing() {
    this.pings++;
  }
  // helpers
  accept() {
    this.connected = true;
    this.emit('packetreceive', { cmd: 'connack' });
    this.emit('connect', {});
  }
  drop() {
    this.connected = false;
    this.emit('close');
  }
}

const clients: FakeClient[] = [];

jest.mock('mqtt', () => ({
  __esModule: true,
  default: {
    connect: jest.fn((url: string, options: any) => {
      const c = new FakeClient(url, options);
      clients.push(c);
      return c;
    }),
  },
}));

import { PNSocket } from '../src/PNSocket';
import { PNConfigBuilder, PNAuthFactory } from '../src/PNConfig';
import { PNState } from '../src/PNState';
import { pnEndpoint } from '../src/PNEndpoint';

const last = () => clients[clients.length - 1];
const live = () => clients.filter((c) => !c.ended);

function socket(configure?: (b: PNConfigBuilder) => PNConfigBuilder) {
  let b = new PNConfigBuilder().gateway('default.example').port(443).clientId('cid').auth(PNAuthFactory.token('t1'));
  if (configure) b = configure(b);
  return new PNSocket(b.build());
}

beforeEach(() => {
  clients.length = 0;
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PNSocket connect options', () => {
  it('uses today\'s default URL, 30 s keepalive and no mqtt.js auto-reconnect', () => {
    const s = socket().open();
    expect(clients).toHaveLength(1);
    expect(last().url).toBe('wss://default.example:443/mqtt');
    expect(last().options.keepalive).toBe(30);
    expect(last().options.reconnectPeriod).toBe(0);
    expect(last().options.password).toBe('t1');
    expect(s.state).toBe(PNState.CONNECTING);
  });

  it('uses updated credentials on the next attempt', () => {
    const s = socket().open();
    s.updateAuth(PNAuthFactory.token('t2'));
    s.reconnectImmediately(true);
    expect(last().options.password).toBe('t2');
  });
});

describe('PNSocket single client', () => {
  it('never runs two clients at once', () => {
    const s = socket();
    s.open();
    s.open();
    s.reconnectImmediately();
    expect(clients).toHaveLength(1);

    s.reconnectImmediately(true);
    expect(clients).toHaveLength(2);
    expect(clients[0].ended).toBe(true);
    expect(live()).toHaveLength(1);
  });

  it('ignores events from an abandoned client', () => {
    const s = socket();
    const onDisconnected = jest.fn();
    const onConnected = jest.fn();
    s.addConnectionListener({ onDisconnected, onConnected });
    s.open();
    const old = last();
    s.reconnectImmediately(true);
    old.emit('connect', {});
    old.emit('close');
    old.emit('error', new Error('boom'));
    expect(onConnected).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5_000);
    expect(clients).toHaveLength(2);
    expect(live()).toHaveLength(1);
  });

  it('close() stops everything', () => {
    const s = socket().open();
    last().accept();
    s.close();
    expect(last().ended).toBe(true);
    jest.advanceTimersByTime(600_000);
    expect(clients).toHaveLength(1);
    expect(s.state).toBe(PNState.DISCONNECTED);
  });
});

describe('PNSocket endpoint failover', () => {
  const a = pnEndpoint('a.example', 443, true, '/mqtt');
  const b = pnEndpoint('b.example', 8084, false, '/ws');

  it('tries the next endpoint when one is unreachable, and reports the winner', () => {
    const s = socket();
    const winners: string[] = [];
    s.setEndpointProvider(() => [a, b, pnEndpoint('default.example', 443)]);
    s.addEndpointListener((e) => winners.push(e.host));
    s.open();
    expect(last().url).toBe('wss://a.example:443/mqtt');
    last().drop(); // closed before CONNACK
    jest.advanceTimersByTime(250);
    expect(last().url).toBe('ws://b.example:8084/ws');
    last().accept();
    expect(winners).toEqual(['b.example']);
    expect(s.connectedEndpoint()).toEqual(b);
    expect(s.state).toBe(PNState.CONNECTED);
  });

  it('fails over on a connect error and on a timeout', () => {
    const s = socket((c) => c.connectionTimeout(10));
    s.setEndpointProvider(() => [a, b, pnEndpoint('default.example', 443)]);
    s.open();
    last().emit('error', new Error('WebSocket error'));
    jest.advanceTimersByTime(250);
    expect(last().url).toContain('b.example');
    // no answer at all
    jest.advanceTimersByTime(12_000);
    jest.advanceTimersByTime(250);
    expect(last().url).toBe('wss://default.example:443/mqtt');
    expect(live()).toHaveLength(1);
  });

  it('does not fail over when the broker rejects the credentials', () => {
    const s = socket();
    s.setEndpointProvider(() => [a, b]);
    const onReconnecting = jest.fn();
    s.addConnectionListener({ onReconnecting });
    s.open();
    const err: any = new Error('Connection refused: Not authorized');
    err.code = 135;
    last().emit('error', err);
    jest.advanceTimersByTime(250);
    expect(clients).toHaveLength(1);
    expect(s.state).toBe(PNState.RECONNECTING);
    expect(onReconnecting).toHaveBeenCalledTimes(1);
    // after the backoff, a new round starts from the first endpoint
    jest.advanceTimersByTime(1300);
    expect(clients).toHaveLength(2);
    expect(last().url).toContain('a.example');
  });

  it('backs off after all endpoints failed, then restarts from the first', () => {
    const s = socket();
    s.setEndpointProvider(() => [a, b]);
    s.open();
    last().drop();
    jest.advanceTimersByTime(250);
    last().drop();
    expect(s.state).toBe(PNState.RECONNECTING);
    jest.advanceTimersByTime(1300);
    expect(last().url).toContain('a.example');
  });

  it('uses the config gateway when the provider returns nothing', () => {
    const s = socket((c) => c.wsPath('/custom'));
    s.setEndpointProvider(() => []);
    s.open();
    expect(last().url).toBe('wss://default.example:443/custom');
  });
});

describe('PNSocket reconnect backoff', () => {
  it('never gives up and never waits more than 60 s (+20 %)', () => {
    const s = socket();
    const delays: number[] = [];
    s.addConnectionListener({ onReconnecting: (_a, ms) => delays.push(ms) });
    s.open();
    last().accept();
    last().drop();
    for (let i = 0; i < 30; i++) {
      const before = clients.length;
      while (clients.length === before) jest.advanceTimersByTime(100);
      last().drop();
    }
    expect(delays.length).toBe(31);
    expect(delays.slice(10).every((d) => d >= 48_000)).toBe(true);
    expect(Math.max(...delays)).toBeLessThanOrEqual(72_000);
    expect(delays[0]).toBeLessThanOrEqual(1200);
    expect(delays[0]).toBeGreaterThanOrEqual(800);
    expect(live()).toHaveLength(0);
    expect(s.state).toBe(PNState.RECONNECTING);
  });

  it('reconnectImmediately() resets the backoff', () => {
    const s = socket();
    const delays: number[] = [];
    s.addConnectionListener({ onReconnecting: (_a, ms) => delays.push(ms) });
    s.open();
    for (let i = 0; i < 8; i++) {
      const before = clients.length;
      last().drop();
      while (clients.length === before) jest.advanceTimersByTime(100);
    }
    last().drop();
    expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(48_000);
    const before = clients.length;
    s.reconnectImmediately();
    expect(clients.length).toBe(before + 1);
    last().drop();
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(1200);
  });

  it('keeps streamed channels across a reconnect', () => {
    const s = socket().open();
    last().accept();
    s.stream('ch/1', () => {});
    last().drop();
    jest.advanceTimersByTime(1300);
    last().accept();
    expect(last().subscribe).toHaveBeenCalledWith('ch/1', expect.anything());
    expect(s.getActiveChannels().has('ch/1')).toBe(true);
  });
});

describe('PNSocket probe', () => {
  it('resolves true when the gateway answers', async () => {
    const s = socket().open();
    last().accept();
    const p = s.probe(5000);
    expect(last().pings).toBe(1);
    last().emit('packetreceive', { cmd: 'pingresp' });
    await expect(p).resolves.toBe(true);
    expect(clients).toHaveLength(1);
  });

  it('replaces a dead connection', async () => {
    const s = socket().open();
    const onDisconnected = jest.fn();
    s.addConnectionListener({ onDisconnected });
    last().accept();
    const p = s.probe(5000);
    jest.advanceTimersByTime(5000);
    await expect(p).resolves.toBe(false);
    expect(clients).toHaveLength(2);
    expect(clients[0].ended).toBe(true);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(s.state).toBe(PNState.CONNECTING);
  });

  it('does nothing when not connected', async () => {
    const s = socket().open();
    await expect(s.probe()).resolves.toBe(false);
    expect(clients).toHaveLength(1);
  });
});
