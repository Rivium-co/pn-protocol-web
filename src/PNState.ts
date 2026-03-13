/**
 * Connection states for PNSocket
 */
export enum PNState {
  /** Not connected to gateway */
  DISCONNECTED = 'disconnected',

  /** Establishing connection */
  CONNECTING = 'connecting',

  /** Connected and ready */
  CONNECTED = 'connected',

  /** Reconnecting after connection loss */
  RECONNECTING = 'reconnecting',

  /** Gracefully disconnecting */
  DISCONNECTING = 'disconnecting',
}
