import { PNEndpoint, pnEndpointEquals } from './PNEndpoint';

/**
 * Exponential backoff with jitter: base * 2^attempt, capped at max, then ±20 %.
 */
export const PNBackoff = {
  MULTIPLIER: 2,
  JITTER_FACTOR: 0.2,
  MAX_EXPONENT: 30,

  /**
   * @param attempt 0-based retry attempt
   * @param baseMs first delay
   * @param maxMs cap applied before jitter
   * @param random a value in [0, 1] (Math.random() in production)
   */
  delay(attempt: number, baseMs: number, maxMs: number, random: number = Math.random()): number {
    const base = Math.max(0, baseMs);
    const max = Math.max(maxMs, base);
    const exponent = Math.min(Math.max(0, Math.floor(attempt)), PNBackoff.MAX_EXPONENT);
    const capped = Math.min(base * Math.pow(PNBackoff.MULTIPLIER, exponent), max);
    const r = Math.min(Math.max(random, 0), 1);
    const factor = 1 + PNBackoff.JITTER_FACTOR * (r * 2 - 1);
    return Math.max(0, Math.round(capped * factor));
  },
};

/**
 * CONNACK reason codes meaning "the gateway was reached and refused us".
 * MQTT 5: 133 client id not valid, 134 bad user name or password, 135 not authorized.
 * MQTT 3.1.1: 2 identifier rejected, 4 bad user name or password, 5 not authorized.
 */
const BROKER_REJECTION_CODES = new Set([133, 134, 135, 2, 4, 5]);
const BROKER_REJECTION_TEXT = /not authori[sz]ed|bad user ?name or password|client identifier not valid|identifier rejected/i;

export const PNFailures = {
  /**
   * True when the gateway was reached and refused the credentials / client id.
   * Another endpoint of the same service would refuse them too, so there is
   * no point failing over.
   */
  isRejectedByBroker(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const e = error as { code?: unknown; message?: unknown };
    const message = typeof e.message === 'string' ? e.message : '';
    if (typeof e.code === 'number' && BROKER_REJECTION_CODES.has(e.code) && /refused/i.test(message)) {
      return true;
    }
    return BROKER_REJECTION_TEXT.test(message);
  },
};

/**
 * Walks the endpoint list of one connection round.
 */
export class PNEndpointRotation {
  private endpoints: PNEndpoint[] = [];
  private index = 0;
  private active = false;

  inRound(): boolean {
    return this.active;
  }

  startRound(list: PNEndpoint[]): void {
    const unique: PNEndpoint[] = [];
    for (const e of list) {
      if (!unique.some((u) => pnEndpointEquals(u, e))) unique.push(e);
    }
    this.endpoints = unique;
    this.index = 0;
    this.active = unique.length > 0;
  }

  current(): PNEndpoint | null {
    return this.active ? this.endpoints[this.index] ?? null : null;
  }

  position(): number {
    return this.index;
  }

  size(): number {
    return this.endpoints.length;
  }

  /**
   * Record a failed attempt on current().
   * @returns true if the next endpoint should be tried right away; false when the
   *          round is over (all endpoints failed, or the broker rejected us) and the
   *          caller should back off. The next round starts again from the first endpoint.
   */
  onConnectFailure(rejectedByBroker: boolean): boolean {
    if (!this.active) return false;
    if (!rejectedByBroker && this.index + 1 < this.endpoints.length) {
      this.index++;
      return true;
    }
    this.active = false;
    return false;
  }

  /** Record a successful connection; returns the endpoint that worked. */
  onConnected(): PNEndpoint | null {
    const winner = this.current();
    this.active = false;
    return winner;
  }

  reset(): void {
    this.active = false;
    this.index = 0;
  }
}

/**
 * Ensures at most one connect attempt is in flight, and lets callbacks from an
 * abandoned client be recognised (generation no longer current) and ignored.
 */
export class PNConnectGuard {
  private generation = 0;
  private inFlight = false;

  /** Begin an attempt. Returns its generation, or null if one is already in flight. */
  tryBegin(): number | null {
    if (this.inFlight) return null;
    this.inFlight = true;
    this.generation++;
    return this.generation;
  }

  /** End the attempt of gen. Returns false if gen was abandoned meanwhile. */
  finish(gen: number): boolean {
    if (gen !== this.generation) return false;
    this.inFlight = false;
    return true;
  }

  isCurrent(gen: number): boolean {
    return gen === this.generation;
  }

  current(): number {
    return this.generation;
  }

  isInFlight(): boolean {
    return this.inFlight;
  }

  /** Abandon the current attempt/connection: its callbacks become stale. */
  invalidate(): void {
    this.generation++;
    this.inFlight = false;
  }
}
