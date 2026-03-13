import { PNDeliveryMode } from './PNDeliveryMode';

/**
 * Authentication options
 */
export type PNAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'token'; token: string };

export const PNAuthFactory = {
  basic(username: string, password: string): PNAuth {
    return { type: 'basic', username, password };
  },
  token(token: string): PNAuth {
    return { type: 'token', token };
  },
};

/**
 * Exit signal sent when client disconnects unexpectedly (Last Will and Testament)
 */
export interface PNExitSignal {
  /** Channel to send exit signal to */
  channel: string;

  /** Payload to send */
  payload: Uint8Array | string;

  /** Delivery mode */
  mode?: PNDeliveryMode;

  /** Persist the exit signal */
  persist?: boolean;
}

/**
 * Configuration for PNSocket connection
 *
 * | PN Protocol        | Internal              |
 * |--------------------|-----------------------|
 * | gateway            | broker host           |
 * | heartbeatInterval  | keepAliveInterval     |
 * | freshStart         | cleanSession          |
 * | exitSignal         | lastWillAndTestament  |
 */
export interface PNConfig {
  /** Gateway server host */
  gateway: string;

  /** Gateway server port */
  port?: number;

  /** Unique client identifier */
  clientId: string;

  /** Authentication credentials */
  auth?: PNAuth;

  /** Keep connection alive interval in seconds */
  heartbeatInterval?: number;

  /** Connection timeout in seconds */
  connectionTimeout?: number;

  /** Start with fresh state, ignore persisted data */
  freshStart?: boolean;

  /** Auto-reconnect on connection loss */
  autoReconnect?: boolean;

  /** Maximum reconnect attempts (0 = infinite) */
  maxReconnectAttempts?: number;

  /** Initial reconnect delay in milliseconds */
  reconnectDelay?: number;

  /** Maximum reconnect delay in milliseconds */
  maxReconnectDelay?: number;

  /** Exit signal - message sent on unexpected disconnect (Last Will) */
  exitSignal?: PNExitSignal;

  /** Enable secure connection (WSS) */
  secure?: boolean;

  /** WebSocket path (default: /mqtt) */
  wsPath?: string;
}

/**
 * Builder for PNConfig
 */
export class PNConfigBuilder {
  private config: Partial<PNConfig> = {
    port: 443,
    heartbeatInterval: 60,
    connectionTimeout: 30,
    freshStart: true,
    autoReconnect: true,
    maxReconnectAttempts: 10,
    reconnectDelay: 1000,
    maxReconnectDelay: 300000,
    secure: true,
    wsPath: '/mqtt',
  };

  gateway(gateway: string): this {
    this.config.gateway = gateway;
    return this;
  }

  port(port: number): this {
    this.config.port = port;
    return this;
  }

  clientId(clientId: string): this {
    this.config.clientId = clientId;
    return this;
  }

  auth(auth: PNAuth): this {
    this.config.auth = auth;
    return this;
  }

  heartbeatInterval(seconds: number): this {
    this.config.heartbeatInterval = seconds;
    return this;
  }

  connectionTimeout(seconds: number): this {
    this.config.connectionTimeout = seconds;
    return this;
  }

  freshStart(fresh: boolean): this {
    this.config.freshStart = fresh;
    return this;
  }

  autoReconnect(auto: boolean): this {
    this.config.autoReconnect = auto;
    return this;
  }

  maxReconnectAttempts(max: number): this {
    this.config.maxReconnectAttempts = max;
    return this;
  }

  reconnectDelay(delay: number): this {
    this.config.reconnectDelay = delay;
    return this;
  }

  maxReconnectDelay(delay: number): this {
    this.config.maxReconnectDelay = delay;
    return this;
  }

  exitSignal(signal: PNExitSignal): this {
    this.config.exitSignal = signal;
    return this;
  }

  secure(secure: boolean): this {
    this.config.secure = secure;
    return this;
  }

  wsPath(path: string): this {
    this.config.wsPath = path;
    return this;
  }

  build(): PNConfig {
    if (!this.config.gateway) {
      throw new Error('Gateway is required');
    }
    if (!this.config.clientId) {
      throw new Error('Client ID is required');
    }
    return this.config as PNConfig;
  }
}
