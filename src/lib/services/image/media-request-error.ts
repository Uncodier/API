/** Never expose provider response bodies, authenticated URLs or SDK request objects. */
export class MediaRequestError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}