/**
 * Error thrown for input that cannot be converted. `code` is stable and
 * machine-readable; `message` is a plain sentence fit to show a user.
 *
 * Codes: BAD_INPUT, NOT_MSG, CORRUPT_CFB, UNREADABLE, TOO_DEEP.
 */
export class MsgError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'MsgError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
