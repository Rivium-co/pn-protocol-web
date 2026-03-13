/**
 * Error codes for PN Protocol operations
 */
export enum PNErrorCode {
  UNKNOWN = 0,
  CONNECTION_FAILED = 100,
  CONNECTION_LOST = 101,
  CONNECTION_TIMEOUT = 102,
  AUTH_FAILED = 200,
  AUTH_EXPIRED = 201,
  STREAM_FAILED = 300,
  DETACH_FAILED = 301,
  DISPATCH_FAILED = 400,
  INVALID_CONFIG = 500,
  INVALID_MESSAGE = 501,
  NOT_CONNECTED = 600,
}

/**
 * Error from PN Protocol operations
 */
export class PNError extends Error {
  readonly code: PNErrorCode;
  readonly details?: string;

  constructor(code: PNErrorCode, message: string, details?: string) {
    super(message);
    this.name = 'PNError';
    this.code = code;
    this.details = details;
  }

  override toString(): string {
    return `PNError(code=${this.code}, message='${this.message}')`;
  }

  static connectionFailed(message: string, details?: string): PNError {
    return new PNError(PNErrorCode.CONNECTION_FAILED, message, details);
  }

  static connectionLost(message: string, details?: string): PNError {
    return new PNError(PNErrorCode.CONNECTION_LOST, message, details);
  }

  static connectionTimeout(message: string): PNError {
    return new PNError(PNErrorCode.CONNECTION_TIMEOUT, message);
  }

  static authFailed(message: string, details?: string): PNError {
    return new PNError(PNErrorCode.AUTH_FAILED, message, details);
  }

  static authExpired(message: string): PNError {
    return new PNError(PNErrorCode.AUTH_EXPIRED, message);
  }

  static notConnected(): PNError {
    return new PNError(PNErrorCode.NOT_CONNECTED, 'Not connected. Call open() first.');
  }

  static invalidConfig(message: string): PNError {
    return new PNError(PNErrorCode.INVALID_CONFIG, message);
  }

  static fromException(e: Error, defaultMessage = 'Unknown error'): PNError {
    return new PNError(PNErrorCode.UNKNOWN, e.message || defaultMessage, e.stack);
  }
}
