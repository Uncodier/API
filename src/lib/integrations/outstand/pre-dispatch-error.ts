import { ResourceLicenseError } from '@/lib/billing/licensed-resources';
import { SocialAccountResolutionError } from './accounts';

/** Only wrap work completed before entering the provider mutation request. */
export class OutstandPreDispatchError extends Error {
  readonly code = 'OUTSTAND_PRE_DISPATCH_FAILED';
  readonly status: number;
  readonly cause: Error;

  constructor(cause: unknown) {
    super('Social post preparation failed. No post was sent; reuse this content_id when retrying.');
    this.name = 'OutstandPreDispatchError';
    this.status = cause instanceof ResourceLicenseError ? cause.status : 503;
    // Keep trusted diagnostic categories, never provider bodies, credentials or raw messages.
    this.cause = cause instanceof ResourceLicenseError ? new ResourceLicenseError(cause.status)
      : cause instanceof SocialAccountResolutionError
        ? new SocialAccountResolutionError(cause.code, 'Social account authorization could not be completed.')
        : new Error('Outstand pre-dispatch preparation could not be completed.');
  }
}