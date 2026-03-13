import { PNConfig } from './PNConfig';
import { PNSocket } from './PNSocket';
import { PNError, PNErrorCode } from './PNError';

/**
 * Pushino - PN Protocol SDK for Web
 *
 * Lightweight push notification protocol layer.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { Pushino, PNConfigBuilder, PNAuthFactory } from '@tazik561/pn-protocol';
 *
 * // Initialize
 * const config = new PNConfigBuilder()
 *   .gateway('push.example.com')
 *   .port(443)
 *   .clientId('user-12345')
 *   .auth(PNAuthFactory.token('jwt-token'))
 *   .build();
 *
 * Pushino.initialize(config);
 *
 * // Connect
 * Pushino.socket()
 *   .addConnectionListener({
 *     onConnected: () => console.log('Connected!'),
 *     onDisconnected: (reason) => console.log('Disconnected:', reason),
 *   })
 *   .open();
 *
 * // Stream messages
 * Pushino.socket().stream('notifications/user-123', (message) => {
 *   console.log('Received:', message.payloadAsString());
 * });
 *
 * // Dispatch messages
 * Pushino.socket().dispatchText('chat/room-1', 'Hello!');
 *
 * // Disconnect
 * Pushino.shutdown();
 * ```
 *
 * ## Terminology
 *
 * | PN Protocol   | Internal              | Description                    |
 * |---------------|-----------------------|--------------------------------|
 * | gateway       | broker                | Server address                 |
 * | channel       | topic                 | Message destination            |
 * | stream()      | subscribe()           | Listen to messages             |
 * | detach()      | unsubscribe()         | Stop listening                 |
 * | dispatch()    | publish()             | Send a message                 |
 * | exitSignal    | lastWill              | Message on disconnect          |
 * | freshStart    | cleanSession          | Ignore persisted state         |
 * | heartbeat     | keepAlive             | Connection keep-alive          |
 */
export class Pushino {
  private static _socket: PNSocket | null = null;
  private static _config: PNConfig | null = null;

  /** SDK Version */
  static readonly VERSION = '1.0.0';

  /** Protocol identifier */
  static readonly PROTOCOL = 'PN/1.0';

  /**
   * Initialize Pushino with configuration
   */
  static initialize(config: PNConfig): typeof Pushino {
    this._config = config;
    this._socket = new PNSocket(config);
    return this;
  }

  /**
   * Get the active socket connection
   */
  static socket(): PNSocket {
    if (!this._socket) {
      throw new PNError(PNErrorCode.INVALID_CONFIG, 'Pushino not initialized. Call initialize() first.');
    }
    return this._socket;
  }

  /**
   * Check if Pushino is initialized
   */
  static isInitialized(): boolean {
    return this._socket !== null;
  }

  /**
   * Shutdown Pushino and release resources
   */
  static shutdown(): void {
    this._socket?.close();
    this._socket = null;
    this._config = null;
  }

  /**
   * Get current configuration
   */
  static config(): PNConfig | null {
    return this._config;
  }
}
