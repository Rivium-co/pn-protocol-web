import { PNDeliveryMode, deliveryModeFromQos } from './PNDeliveryMode';

/**
 * Message in PN Protocol
 *
 * Wraps messaging with Pushino terminology.
 */
export class PNMessage {
  /** Target channel (topic) */
  readonly channel: string;

  /** Message payload as bytes */
  readonly payload: Uint8Array;

  /** Delivery guarantee mode (QoS) */
  readonly mode: PNDeliveryMode;

  /** Persist message for new subscribers (retain) */
  readonly persist: boolean;

  /** Message timestamp */
  readonly timestamp: number;

  /** Unique message ID */
  readonly id: string;

  constructor(
    channel: string,
    payload: Uint8Array | string,
    mode: PNDeliveryMode = PNDeliveryMode.RELIABLE,
    persist = false,
    timestamp?: number,
    id?: string
  ) {
    this.channel = channel;
    this.payload = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    this.mode = mode;
    this.persist = persist;
    this.timestamp = timestamp ?? Date.now();
    this.id = id ?? crypto.randomUUID();
  }

  /** Get payload as UTF-8 string */
  payloadAsString(): string {
    return new TextDecoder().decode(this.payload);
  }

  /** Get payload as JSON object */
  payloadAsJson<T = unknown>(): T {
    return JSON.parse(this.payloadAsString());
  }

  toString(): string {
    return `PNMessage(id='${this.id}', channel='${this.channel}', mode=${this.mode}, size=${this.payload.length})`;
  }

  /**
   * Create a simple text message
   */
  static text(channel: string, text: string, mode: PNDeliveryMode = PNDeliveryMode.RELIABLE): PNMessage {
    return new PNMessage(channel, text, mode);
  }

  /**
   * Create a JSON message
   */
  static json(channel: string, data: unknown, mode: PNDeliveryMode = PNDeliveryMode.RELIABLE): PNMessage {
    return new PNMessage(channel, JSON.stringify(data), mode);
  }

  /**
   * Create from internal message format
   */
  static fromInternal(topic: string, payload: Uint8Array, qos: number, retained: boolean): PNMessage {
    return new PNMessage(topic, payload, deliveryModeFromQos(qos), retained);
  }
}

/**
 * Builder for PNMessage
 */
export class PNMessageBuilder {
  private _channel = '';
  private _payload: Uint8Array = new Uint8Array();
  private _mode: PNDeliveryMode = PNDeliveryMode.RELIABLE;
  private _persist = false;

  channel(channel: string): this {
    this._channel = channel;
    return this;
  }

  payload(payload: Uint8Array | string): this {
    this._payload = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    return this;
  }

  mode(mode: PNDeliveryMode): this {
    this._mode = mode;
    return this;
  }

  persist(persist: boolean): this {
    this._persist = persist;
    return this;
  }

  build(): PNMessage {
    if (!this._channel) {
      throw new Error('Channel is required');
    }
    return new PNMessage(this._channel, this._payload, this._mode, this._persist);
  }
}
