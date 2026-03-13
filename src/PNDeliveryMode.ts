/**
 * Delivery guarantee modes for PN Protocol
 *
 * | Mode       | QoS | Description                    |
 * |------------|-----|--------------------------------|
 * | FAST       | 0   | Fire and forget, no guarantee  |
 * | RELIABLE   | 1   | At least once delivery         |
 * | EXACT_ONCE | 2   | Exactly once delivery          |
 */
export enum PNDeliveryMode {
  /** Fire and forget - fastest, no guarantee (QoS 0) */
  FAST = 0,

  /** At least once delivery (QoS 1) */
  RELIABLE = 1,

  /** Exactly once delivery (QoS 2) */
  EXACT_ONCE = 2,
}

/**
 * Convert QoS number to PNDeliveryMode
 */
export function deliveryModeFromQos(qos: number): PNDeliveryMode {
  switch (qos) {
    case 0:
      return PNDeliveryMode.FAST;
    case 2:
      return PNDeliveryMode.EXACT_ONCE;
    default:
      return PNDeliveryMode.RELIABLE;
  }
}
