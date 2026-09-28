import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import { PNConfig, PNAuth, PN_DEFAULTS } from './PNConfig';
import { PNState } from './PNState';
import { PNMessage } from './PNMessage';
import { PNDeliveryMode } from './PNDeliveryMode';
import { PNError } from './PNError';
import { PNConnectionListener, PNMessageListener, PNErrorListener } from './PNListeners';
import {
  PNEndpoint,
  PNEndpointListener,
  PNEndpointProvider,
  pnEndpoint,
  pnEndpointUrl,
} from './PNEndpoint';
import { PNBackoff, PNConnectGuard, PNEndpointRotation, PNFailures } from './PNReconnect';

const TAG = 'PNSocket';

/** Pause before trying the next endpoint after a failed attempt. */
const FAILOVER_DELAY_MS = 250;

/** Extra grace on top of the connection timeout before an attempt is abandoned. */
const CONNECT_GRACE_MS = 2000;

/** Default time to wait for any packet after a ping in probe(). */
export const PN_DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Check if running in development mode (browser-safe)
 */
const isDevelopment = (): boolean => {
  try {
    // Check for Node.js environment
    if (typeof process !== 'undefined' && process.env?.NODE_ENV) {
      return process.env.NODE_ENV !== 'production';
    }
  } catch {
    // process is not defined in browser
  }
  // Default to true for development logging in browser
  return true;
};

/**
 * Log utility for debugging
 */
const Log = {
  d: (tag: string, message: string) => {
    if (typeof console !== 'undefined' && isDevelopment()) {
      console.log(`[${tag}] ${message}`);
    }
  },
  e: (tag: string, message: string) => {
    if (typeof console !== 'undefined') {
      console.error(`[${tag}] ERROR: ${message}`);
    }
  },
};

/**
 * PNSocket - Main connection handler for PN Protocol
 *
 * Provides a clean, branded API for real-time messaging.
 *
 * | PN Protocol   | Internal              |
 * |---------------|-----------------------|
 * | open()        | connect()             |
 * | close()       | disconnect()          |
 * | stream()      | subscribe()           |
 * | detach()      | unsubscribe()         |
 * | dispatch()    | publish()             |
 * | channel       | topic                 |
 */
export class PNSocket {
  private client: MqttClient | null = null;
  private readonly config: PNConfig;

  // State
  private _state: PNState = PNState.DISCONNECTED;
  private activeChannels = new Set<string>();

  // Listeners
  private connectionListeners: PNConnectionListener[] = [];
  private messageListeners = new Map<string, PNMessageListener[]>();
  private errorListeners: PNErrorListener[] = [];

  // Reconnection state
  private retryAttempt = 0;
  private manualDisconnect = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  // One connect attempt at a time; callbacks of abandoned clients are ignored
  private readonly connectGuard = new PNConnectGuard();
  private attemptTimer: ReturnType<typeof setTimeout> | null = null;

  // Endpoint failover
  private readonly rotation = new PNEndpointRotation();
  private endpointProvider: PNEndpointProvider | null = null;
  private endpointListeners: PNEndpointListener[] = [];
  private _connectedEndpoint: PNEndpoint | null = null;

  // Liveness
  private lastPacketAt = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private probeResolve: ((alive: boolean) => void) | null = null;

  constructor(config: PNConfig) {
    this.config = { ...config };
  }

  /** Current connection state */
  get state(): PNState {
    return this._state;
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /**
   * Open connection to the gateway
   */
  open(): this {
    if (this._state === PNState.CONNECTED || this._state === PNState.CONNECTING) {
      return this;
    }

    this.manualDisconnect = false;
    this.resetRetryState();
    this.rotation.reset();
    this.connectInternal();
    return this;
  }

  /**
   * Close connection gracefully. Nothing reconnects until open() or
   * reconnectImmediately() is called again.
   */
  close(): this {
    this.manualDisconnect = true;
    this.cancelRetry();
    this.cancelProbe(false);
    this.rotation.reset();
    // Any attempt still in flight is abandoned: its callbacks become no-ops
    this.connectGuard.invalidate();
    this.clearAttemptTimer();

    const client = this.client;
    this.client = null;
    this._connectedEndpoint = null;
    if (client) this.teardownClient(client);

    if (this._state === PNState.DISCONNECTED) {
      this.activeChannels.clear();
      return this;
    }

    Log.d(TAG, 'Closing connection');
    this.setState(PNState.DISCONNECTING);
    this.activeChannels.clear();
    this.setState(PNState.DISCONNECTED);
    return this;
  }

  /**
   * Reconnect now with the backoff reset, keeping streamed channels.
   * No-op while connected or connecting unless `force` is true; with `force`
   * an existing connection or in-flight attempt is dropped first (use it when
   * the current connection may be dead, e.g. after a network change).
   */
  reconnectImmediately(force = false): this {
    if (!force && (this._state === PNState.CONNECTED || this._state === PNState.CONNECTING)) {
      Log.d(TAG, `reconnectImmediately() skipped - state is ${this._state}`);
      return this;
    }

    Log.d(TAG, `Reconnecting immediately (force=${force}, state=${this._state})`);
    this.manualDisconnect = false;
    this.resetRetryState();
    this.rotation.reset();

    if (force) {
      const wasConnected = this._state === PNState.CONNECTED;
      this.cancelProbe(false);
      this.connectGuard.invalidate();
      this.clearAttemptTimer();
      const client = this.client;
      this.client = null;
      this._connectedEndpoint = null;
      if (client) this.teardownClient(client);
      if (wasConnected) {
        this.setState(PNState.DISCONNECTED);
        this.notifyDisconnected('Reconnecting');
      } else {
        this._state = PNState.DISCONNECTED;
      }
    }

    this.connectInternal();
    return this;
  }

  /**
   * Check that an established connection is still alive, e.g. after the page
   * was hidden for a while. Sends a ping; if nothing arrives from the gateway
   * within `timeoutMs`, the connection is replaced (reconnectImmediately(true)).
   * Resolves true when the connection answered, false when it was replaced or
   * there was no connection to check.
   */
  probe(timeoutMs: number = PN_DEFAULT_PROBE_TIMEOUT_MS): Promise<boolean> {
    if (this._state !== PNState.CONNECTED || !this.client) return Promise.resolve(false);
    if (this.probeResolve) {
      // A probe is already running; its result covers this call too.
      return new Promise((resolve) => {
        const previous = this.probeResolve!;
        this.probeResolve = (alive) => {
          previous(alive);
          resolve(alive);
        };
      });
    }

    const client = this.client;
    const gen = this.connectGuard.current();

    if (!client.connected) {
      Log.d(TAG, 'probe(): client no longer connected - reconnecting');
      this.reconnectImmediately(true);
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      this.probeResolve = resolve;
      try {
        sendPing(client);
      } catch (e) {
        Log.d(TAG, `probe(): ping failed (${(e as Error)?.message}) - reconnecting`);
        this.cancelProbe(false);
        this.reconnectImmediately(true);
        return;
      }
      Log.d(TAG, `probe(): ping sent, waiting up to ${timeoutMs}ms`);
      this.probeTimer = setTimeout(() => {
        this.probeTimer = null;
        if (this._state === PNState.CONNECTED && this.client === client && this.connectGuard.isCurrent(gen)) {
          Log.d(TAG, `probe(): no answer within ${timeoutMs}ms - reconnecting`);
          this.cancelProbe(false);
          this.reconnectImmediately(true);
        } else {
          this.cancelProbe(false);
        }
      }, timeoutMs);
    });
  }

  /**
   * Replace the credentials used by the next connection attempt
   * (e.g. after a token refresh). Does not touch the current connection.
   */
  updateAuth(auth: PNAuth): this {
    this.config.auth = auth;
    return this;
  }

  /**
   * Endpoints to try, in order, at the start of each connection round.
   * Without a provider (or when it returns an empty list) the
   * gateway/port/secure/wsPath from PNConfig is used, as before.
   */
  setEndpointProvider(provider: PNEndpointProvider | null): this {
    this.endpointProvider = provider;
    return this;
  }

  addEndpointListener(listener: PNEndpointListener): this {
    this.endpointListeners.push(listener);
    return this;
  }

  removeEndpointListener(listener: PNEndpointListener): this {
    const index = this.endpointListeners.indexOf(listener);
    if (index !== -1) this.endpointListeners.splice(index, 1);
    return this;
  }

  /** Endpoint of the current connection, or null when not connected. */
  connectedEndpoint(): PNEndpoint | null {
    return this._connectedEndpoint;
  }

  /** Time (ms since epoch) the last packet was received from the gateway, 0 if never. */
  lastActivityAt(): number {
    return this.lastPacketAt;
  }

  /**
   * Stream messages from a channel (subscribe)
   *
   * @param channel - Channel name to listen to
   * @param listener - Message listener callback
   * @param mode - Delivery guarantee mode (default: RELIABLE)
   */
  stream(channel: string, listener: PNMessageListener, mode: PNDeliveryMode = PNDeliveryMode.RELIABLE): this {
    if (this._state !== PNState.CONNECTED) {
      const error = PNError.notConnected();
      this.notifyError(error);
      return this;
    }

    if (!this.messageListeners.has(channel)) {
      this.messageListeners.set(channel, []);
    }
    this.messageListeners.get(channel)!.push(listener);

    if (!this.activeChannels.has(channel)) {
      this.client?.subscribe(channel, { qos: mode });
      this.activeChannels.add(channel);
      Log.d(TAG, `Streaming from channel: ${channel}`);
    }

    return this;
  }

  /**
   * Stream with pattern matching (wildcard channels)
   */
  streamPattern(pattern: string, listener: PNMessageListener, mode: PNDeliveryMode = PNDeliveryMode.RELIABLE): this {
    return this.stream(pattern, listener, mode);
  }

  /**
   * Stop streaming from a channel (unsubscribe)
   */
  detach(channel: string): this {
    if (!this.activeChannels.has(channel)) {
      return this;
    }

    this.client?.unsubscribe(channel);
    this.activeChannels.delete(channel);
    this.messageListeners.delete(channel);
    Log.d(TAG, `Detached from channel: ${channel}`);

    return this;
  }

  /**
   * Dispatch a message to a channel (publish)
   */
  dispatch(message: PNMessage): this {
    if (this._state !== PNState.CONNECTED) {
      const error = PNError.notConnected();
      this.notifyError(error);
      return this;
    }

    this.client?.publish(message.channel, Buffer.from(message.payload), {
      qos: message.mode,
      retain: message.persist,
    });
    Log.d(TAG, `Dispatched message to ${message.channel}`);

    return this;
  }

  /**
   * Dispatch a text message
   */
  dispatchText(channel: string, text: string, mode: PNDeliveryMode = PNDeliveryMode.RELIABLE): this {
    return this.dispatch(PNMessage.text(channel, text, mode));
  }

  /**
   * Dispatch a JSON message
   */
  dispatchJson(channel: string, data: unknown, mode: PNDeliveryMode = PNDeliveryMode.RELIABLE): this {
    return this.dispatch(PNMessage.json(channel, data, mode));
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._state === PNState.CONNECTED && this.client?.connected === true;
  }

  /**
   * Get active channels
   */
  getActiveChannels(): Set<string> {
    return new Set(this.activeChannels);
  }

  // ========================================================================
  // Listeners
  // ========================================================================

  addConnectionListener(listener: PNConnectionListener): this {
    this.connectionListeners.push(listener);
    return this;
  }

  removeConnectionListener(listener: PNConnectionListener): this {
    const index = this.connectionListeners.indexOf(listener);
    if (index !== -1) {
      this.connectionListeners.splice(index, 1);
    }
    return this;
  }

  addErrorListener(listener: PNErrorListener): this {
    this.errorListeners.push(listener);
    return this;
  }

  removeErrorListener(listener: PNErrorListener): this {
    const index = this.errorListeners.indexOf(listener);
    if (index !== -1) {
      this.errorListeners.splice(index, 1);
    }
    return this;
  }

  // ========================================================================
  // Internal Implementation
  // ========================================================================

  private defaultEndpoint(): PNEndpoint {
    const { gateway, port = 443, secure = true, wsPath } = this.config;
    return pnEndpoint(gateway, port, secure, wsPath);
  }

  private resolveEndpoints(): PNEndpoint[] {
    let provided: PNEndpoint[] = [];
    try {
      provided = this.endpointProvider?.() ?? [];
    } catch (e) {
      Log.d(TAG, `Endpoint provider failed: ${(e as Error)?.message}`);
      provided = [];
    }
    return provided.length > 0 ? provided : [this.defaultEndpoint()];
  }

  private buildOptions(): IClientOptions {
    const options: IClientOptions = {
      clientId: this.config.clientId,
      clean: this.config.freshStart ?? true,
      keepalive: this.config.heartbeatInterval ?? PN_DEFAULTS.heartbeatInterval,
      connectTimeout: (this.config.connectionTimeout ?? PN_DEFAULTS.connectionTimeout) * 1000,
      reconnectPeriod: 0, // We handle reconnection ourselves
      protocolVersion: 5,
    };

    // Authentication
    if (this.config.auth) {
      if (this.config.auth.type === 'basic') {
        options.username = this.config.auth.username;
        options.password = this.config.auth.password;
      } else if (this.config.auth.type === 'token') {
        options.username = 'jwt';
        options.password = this.config.auth.token;
      }
    }

    // Exit signal (Last Will)
    if (this.config.exitSignal) {
      const payload =
        typeof this.config.exitSignal.payload === 'string'
          ? new TextEncoder().encode(this.config.exitSignal.payload)
          : this.config.exitSignal.payload;
      options.will = {
        topic: this.config.exitSignal.channel,
        payload: Buffer.from(payload),
        qos: this.config.exitSignal.mode ?? PNDeliveryMode.RELIABLE,
        retain: this.config.exitSignal.persist ?? false,
      };
    }

    return options;
  }

  private connectInternal(): void {
    // Never two clients at once: an attempt in flight wins
    const gen = this.connectGuard.tryBegin();
    if (gen === null) {
      Log.d(TAG, 'Connection already in progress - skipping');
      return;
    }

    // Drop any previous client before creating a new one
    const previous = this.client;
    this.client = null;
    if (previous) this.teardownClient(previous);

    if (!this.rotation.inRound()) {
      this.rotation.startRound(this.resolveEndpoints());
    }
    const endpoint = this.rotation.current() ?? this.defaultEndpoint();
    const url = pnEndpointUrl(endpoint);

    this.setState(PNState.CONNECTING);
    Log.d(
      TAG,
      `Connecting to gateway: ${url} (clientId: ${this.config.clientId}, endpoint ${this.rotation.position() + 1}/${Math.max(1, this.rotation.size())})`,
    );

    let settled = false; // CONNACK received or attempt failed
    let lost = false; // connection loss already handled

    const failAttempt = (error: unknown, reason: string) => {
      if (settled) return;
      settled = true;
      this.clearAttemptTimer();
      if (!this.connectGuard.finish(gen)) {
        // A newer attempt (or close()) replaced this one
        return;
      }
      if (this.client === client) this.client = null;
      this.teardownClient(client);
      this.setState(PNState.DISCONNECTED);
      this.notifyError(PNError.connectionFailed(reason));

      if (this.manualDisconnect) return;

      const rejected = PNFailures.isRejectedByBroker(error);
      if (this.rotation.onConnectFailure(rejected)) {
        Log.d(TAG, `Endpoint unreachable - trying next endpoint ${url}`);
        this.scheduleFailover();
      } else if (this.config.autoReconnect ?? true) {
        this.scheduleRetry();
      }
    };

    let client: MqttClient;
    try {
      client = mqtt.connect(url, this.buildOptions());
    } catch (e) {
      Log.e(TAG, `Connection error: ${(e as Error)?.message}`);
      settled = true;
      this.connectGuard.finish(gen);
      this.setState(PNState.DISCONNECTED);
      this.notifyError(PNError.connectionFailed((e as Error)?.message || 'Connection failed'));
      if (!this.manualDisconnect && (this.config.autoReconnect ?? true)) {
        if (this.rotation.onConnectFailure(false)) this.scheduleFailover();
        else this.scheduleRetry();
      }
      return;
    }
    this.client = client;

    const timeoutMs = (this.config.connectionTimeout ?? PN_DEFAULTS.connectionTimeout) * 1000 + CONNECT_GRACE_MS;
    this.attemptTimer = setTimeout(() => {
      this.attemptTimer = null;
      if (this.connectGuard.isCurrent(gen)) failAttempt(null, 'Connection timeout');
    }, timeoutMs);

    client.on('connect', () => {
      if (!this.connectGuard.isCurrent(gen) || settled) {
        if (!this.connectGuard.isCurrent(gen)) this.teardownClient(client);
        return;
      }
      settled = true;
      this.clearAttemptTimer();
      this.connectGuard.finish(gen);
      Log.d(TAG, `Connected to gateway ${url}`);
      this.lastPacketAt = Date.now();
      this.resetRetryState();
      this.rotation.onConnected();
      this._connectedEndpoint = endpoint;
      this.setState(PNState.CONNECTED);
      this.notifyConnected();
      this.notifyEndpointConnected(endpoint);
      this.resubscribeChannels();
    });

    client.on('packetreceive', () => {
      if (!this.connectGuard.isCurrent(gen)) return;
      this.lastPacketAt = Date.now();
      if (this.probeResolve && this.client === client) this.cancelProbe(true);
    });

    client.on('message', (topic: string, payload: Buffer) => {
      if (!this.connectGuard.isCurrent(gen)) return;
      const message = PNMessage.fromInternal(topic, new Uint8Array(payload), 1, false);
      Log.d(TAG, `Message received on channel: ${topic}`);
      this.notifyMessage(message);
    });

    client.on('error', (error: Error) => {
      if (!this.connectGuard.isCurrent(gen)) return;
      Log.e(TAG, `Connection error: ${error?.message}`);
      if (!settled) {
        failAttempt(error, error?.message || 'Connection failed');
      } else {
        this.notifyError(PNError.connectionFailed(error?.message || 'Connection error'));
      }
    });

    client.on('close', () => {
      if (!this.connectGuard.isCurrent(gen)) return;
      if (!settled) {
        // Closed before CONNACK: unreachable endpoint (or refused at the socket level)
        failAttempt(null, 'Connection closed before the gateway accepted it');
        return;
      }
      if (lost) return;
      lost = true;
      this.handleConnectionLost(client);
    });

    client.on('offline', () => {
      Log.d(TAG, 'Client offline');
    });
  }

  private handleConnectionLost(client: MqttClient): void {
    Log.d(TAG, `Connection closed (manualDisconnect: ${this.manualDisconnect})`);
    this.cancelProbe(false);
    if (this.client === client) this.client = null;
    this.teardownClient(client);
    // Stale callbacks from this client are ignored from now on
    this.connectGuard.invalidate();
    this._connectedEndpoint = null;
    this.rotation.reset();
    // activeChannels is intentionally kept so they are restored after reconnect
    this.setState(PNState.DISCONNECTED);
    this.notifyDisconnected();

    if (!this.manualDisconnect && (this.config.autoReconnect ?? true)) {
      this.scheduleRetry();
    }
  }

  /** Remove our handlers, keep a no-op error handler, and end the client. Never throws. */
  private teardownClient(client: MqttClient): void {
    try {
      client.removeAllListeners();
      client.on('error', () => {});
    } catch {
      // ignore
    }
    try {
      client.end(true);
    } catch {
      // ignore
    }
  }

  private clearAttemptTimer(): void {
    if (this.attemptTimer) {
      clearTimeout(this.attemptTimer);
      this.attemptTimer = null;
    }
  }

  private cancelProbe(alive: boolean): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    const resolve = this.probeResolve;
    this.probeResolve = null;
    resolve?.(alive);
  }

  private resubscribeChannels(): void {
    if (this.activeChannels.size === 0) return;

    for (const channel of this.activeChannels) {
      this.client?.subscribe(channel, { qos: PNDeliveryMode.RELIABLE });
    }
    Log.d(TAG, `Resubscribed to ${this.activeChannels.size} channels`);
  }

  // ========================================================================
  // Reconnection with Exponential Backoff
  // ========================================================================

  private calculateRetryDelay(attempt: number): number {
    return PNBackoff.delay(
      attempt,
      this.config.reconnectDelay ?? PN_DEFAULTS.reconnectDelay,
      this.config.maxReconnectDelay ?? PN_DEFAULTS.maxReconnectDelay,
      Math.random(),
    );
  }

  private scheduleFailover(): void {
    this.cancelRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.manualDisconnect) this.connectInternal();
    }, FAILOVER_DELAY_MS);
  }

  private scheduleRetry(): void {
    if (this.manualDisconnect) return;

    const maxAttempts = this.config.maxReconnectAttempts ?? PN_DEFAULTS.maxReconnectAttempts;
    if (maxAttempts > 0 && this.retryAttempt >= maxAttempts) {
      Log.e(TAG, `Max retry attempts (${maxAttempts}) reached`);
      const error = PNError.connectionFailed(`Max retry attempts reached after ${this.retryAttempt} attempts`);
      this.notifyError(error);
      return;
    }

    const delay = this.calculateRetryDelay(this.retryAttempt);
    Log.d(TAG, `Scheduling retry ${this.retryAttempt + 1} in ${delay}ms`);

    this.cancelRetry();
    this.setState(PNState.RECONNECTING);
    this.notifyReconnecting(this.retryAttempt, delay);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.manualDisconnect) return;
      this.retryAttempt++;
      Log.d(TAG, `Executing retry attempt ${this.retryAttempt}`);
      this.connectInternal();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private resetRetryState(): void {
    this.retryAttempt = 0;
    this.cancelRetry();
  }

  // ========================================================================
  // Notification Helpers
  // ========================================================================

  private setState(newState: PNState): void {
    this._state = newState;
    this.connectionListeners.forEach((listener) => listener.onStateChanged?.(newState));
  }

  private notifyConnected(): void {
    this.connectionListeners.forEach((listener) => listener.onConnected?.());
  }

  private notifyDisconnected(reason?: string): void {
    this.connectionListeners.forEach((listener) => listener.onDisconnected?.(reason));
  }

  private notifyReconnecting(attempt: number, nextRetryMs: number): void {
    this.connectionListeners.forEach((listener) => listener.onReconnecting?.(attempt, nextRetryMs));
  }

  private notifyEndpointConnected(endpoint: PNEndpoint): void {
    this.endpointListeners.forEach((listener) => {
      try {
        listener(endpoint);
      } catch (e) {
        Log.e(TAG, `Endpoint listener failed: ${(e as Error)?.message}`);
      }
    });
  }

  private notifyError(error: PNError): void {
    this.errorListeners.forEach((listener) => listener(error));
  }

  private notifyMessage(message: PNMessage): void {
    // Notify exact channel listeners
    const listeners = this.messageListeners.get(message.channel);
    listeners?.forEach((listener) => listener(message));

    // Also check pattern listeners
    for (const [pattern, patternListeners] of this.messageListeners) {
      if (pattern !== message.channel && this.matchesPattern(pattern, message.channel)) {
        patternListeners.forEach((listener) => listener(message));
      }
    }
  }

  private matchesPattern(pattern: string, topic: string): boolean {
    if (!pattern.includes('+') && !pattern.includes('#')) {
      return pattern === topic;
    }

    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');

    let i = 0;
    for (const part of patternParts) {
      if (part === '#') return true;
      if (part === '+') {
        i++;
        continue;
      }
      if (i >= topicParts.length || topicParts[i] !== part) return false;
      i++;
    }
    return i === topicParts.length;
  }
}

/** Send an MQTT PINGREQ. mqtt.js >= 5.x exposes sendPing(); older builds only the internal sender. */
function sendPing(client: MqttClient): void {
  const c = client as unknown as { sendPing?: () => void; _sendPacket?: (packet: { cmd: string }) => void };
  if (typeof c.sendPing === 'function') {
    c.sendPing();
  } else if (typeof c._sendPacket === 'function') {
    c._sendPacket({ cmd: 'pingreq' });
  } else {
    throw new Error('ping not supported');
  }
}
