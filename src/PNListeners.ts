import { PNState } from './PNState';
import { PNError } from './PNError';
import { PNMessage } from './PNMessage';

/**
 * Listener for connection state changes
 */
export interface PNConnectionListener {
  /** Called when connection state changes */
  onStateChanged?(state: PNState): void;

  /** Called when successfully connected */
  onConnected?(): void;

  /** Called when disconnected */
  onDisconnected?(reason?: string): void;

  /** Called when reconnecting (with retry info) */
  onReconnecting?(attempt: number, nextRetryMs: number): void;
}

/**
 * Listener for incoming messages
 */
export type PNMessageListener = (message: PNMessage) => void;

/**
 * Listener for errors
 */
export type PNErrorListener = (error: PNError) => void;

/**
 * Callback for dispatch (publish) operations
 */
export interface PNDispatchCallback {
  onSuccess(messageId: string): void;
  onFailure(error: PNError): void;
}
