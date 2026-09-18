import { NextResponse } from 'next/server';
import { VisitorIdentityError, identityErrorBody } from './contracts';

export function visitorIdentityRouteError(error: unknown): NextResponse {
  const identityError = error instanceof VisitorIdentityError
    ? error
    : new VisitorIdentityError('internal_error', 'Unable to process identity request', 500);
  return NextResponse.json(identityErrorBody(identityError), { status: identityError.status });
}

export function assertRouteIdentity(
  pathSessionId: string,
  bodySessionId: string,
  bodySiteId: string,
  querySiteId: string | null
): void {
  if (pathSessionId !== bodySessionId || (querySiteId && querySiteId !== bodySiteId)) {
    throw new VisitorIdentityError('invalid_request', 'Identity request path does not match its body', 400);
  }
}
