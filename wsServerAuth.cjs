const { createHmac, timingSafeEqual } = require('node:crypto');

const VISITOR_SESSION_PROTOCOL = 'visitor-session-token';

function getSecret() {
  return (
    process.env.VISITOR_SESSION_TOKEN_SECRET
    || process.env.ENCRYPTION_KEY
  )?.trim();
}

function selectVisitorSessionProtocol(protocols) {
  return protocols.has(VISITOR_SESSION_PROTOCOL)
    ? VISITOR_SESSION_PROTOCOL
    : false;
}

function authorizeWebSocketUpgrade(request, expected) {
  const protocols = String(
    request.headers['sec-websocket-protocol'] || '',
  ).split(',').map(value => value.trim()).filter(Boolean);
  const markerIndex = protocols.indexOf(VISITOR_SESSION_PROTOCOL);
  const token = markerIndex >= 0 ? protocols[markerIndex + 1] : null;
  const secret = getSecret();
  if (!token || !secret) return null;

  const [payload, suppliedSignature, ...extra] = token.split('.');
  if (!payload || !suppliedSignature || extra.length > 0) return null;
  const expectedSignature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  const supplied = Buffer.from(suppliedSignature);
  const calculated = Buffer.from(expectedSignature);
  if (
    supplied.length !== calculated.length
    || !timingSafeEqual(supplied, calculated)
  ) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      claims.siteId !== expected.siteId
      || claims.sessionId !== expected.sessionId
      || claims.visitorId !== expected.visitorId
      || !Number.isFinite(claims.expiresAt)
      || claims.expiresAt <= Date.now()
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

module.exports = {
  VISITOR_SESSION_PROTOCOL,
  authorizeWebSocketUpgrade,
  selectVisitorSessionProtocol,
};
