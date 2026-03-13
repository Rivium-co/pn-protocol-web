import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import { PNConfig } from './PNConfig';
import { PNState } from './PNState';
import { PNMessage } from './PNMessage';
import { PNDeliveryMode } from './PNDeliveryMode';
import { PNError } from './PNError';
import { PNConnectionListener, PNMessageListener, PNErrorListener } from './PNListeners';

const TAG = 'PNSocket';
const BACKOFF_MULTIPLIER = 2.0;
const JITTER_FACTOR = 0.2;

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
  private isRetrying = false;
  private manualDisconnect = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: PNConfig) {
    this.config = config;
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
    this.connectInternal();
    return this;
  }

  /**
   * Close connection gracefully
   */
  close(): this {
    if (this._state === PNState.DISCONNECTED) {
      return this;
    }

    Log.d(TAG, 'Closing connection');
    this.manualDisconnect = true;
    this.cancelRetry();

    this.setState(PNState.DISCONNECTING);

    this.client?.end(true);
    this.client = null;
    this.activeChannels.clear();

    this.setState(PNState.DISCONNECTED);
    return this;
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

  private connectInternal(): void {
    this.setState(PNState.CONNECTING);

    const { gateway, port = 443, clientId, secure = true, wsPath = '/mqtt' } = this.config;
    const protocol = secure ? 'wss' : 'ws';
    const url = `${protocol}://${gateway}:${port}${wsPath}`;

    Log.d(TAG, `Connecting to gateway: ${url} (clientId: ${clientId})`);

    const options: IClientOptions = {
      clientId,
      clean: this.config.freshStart ?? true,
      keepalive: this.config.heartbeatInterval ?? 60,
      connectTimeout: (this.config.connectionTimeout ?? 30) * 1000,
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

    this.client = mqtt.connect(url, options);

    this.client.on('connect', () => {
      Log.d(TAG, 'Connected to gateway');
      this.resetRetryState();
      this.setState(PNState.CONNECTED);
      this.notifyConnected();
      this.resubscribeChannels();
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      const message = PNMessage.fromInternal(topic, new Uint8Array(payload), 1, false);
      Log.d(TAG, `Message received on channel: ${topic}`);
      this.notifyMessage(message);
    });

    this.client.on('close', () => {
      Log.d(TAG, `Connection closed (manualDisconnect: ${this.manualDisconnect})`);
      this.setState(PNState.DISCONNECTED);
      this.notifyDisconnected();

      if (!this.manualDisconnect && this.config.autoReconnect) {
        this.scheduleRetry();
      }
    });

    this.client.on('disconnect', (packet: any) => {
      Log.d(TAG, `Disconnect packet received: ${JSON.stringify(packet)}`);
    });

    this.client.on('error', (error: Error) => {
      Log.e(TAG, `Connection error: ${error.message}`);
      const pnError = PNError.connectionFailed(error.message);
      this.notifyError(pnError);

      if (!this.manualDisconnect && this.config.autoReconnect) {
        this.scheduleRetry();
      }
    });

    this.client.on('offline', () => {
      Log.d(TAG, 'Client offline');
      if (this._state !== PNState.DISCONNECTING) {
        this.setState(PNState.DISCONNECTED);
      }
    });
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
    const exponentialDelay = (this.config.reconnectDelay ?? 1000) * Math.pow(BACKOFF_MULTIPLIER, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxReconnectDelay ?? 300000);
    const jitter = cappedDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
    return cappedDelay + jitter;
  }

  private scheduleRetry(): void {
    if (this.manualDisconnect) return;

    const maxAttempts = this.config.maxReconnectAttempts ?? 10;
    if (maxAttempts > 0 && this.retryAttempt >= maxAttempts) {
      Log.e(TAG, `Max retry attempts (${maxAttempts}) reached`);
      const error = PNError.connectionFailed(`Max retry attempts reached after ${this.retryAttempt} attempts`);
      this.notifyError(error);
      return;
    }

    const delay = this.calculateRetryDelay(this.retryAttempt);
    Log.d(TAG, `Scheduling retry ${this.retryAttempt + 1} in ${delay}ms`);

    this.setState(PNState.RECONNECTING);
    this.notifyReconnecting(this.retryAttempt, delay);

    this.isRetrying = true;
    this.retryTimer = setTimeout(() => {
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
    this.isRetrying = false;
  }

  private resetRetryState(): void {
    this.retryAttempt = 0;
    this.isRetrying = false;
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
