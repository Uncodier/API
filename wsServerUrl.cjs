const REQUEST_BASE = 'http://websocket.invalid';
const SECURITY_QUERY_PARAMETERS = ['site_id', 'session_id', 'visitor_id', 'conversation_id'];

// IncomingMessage.url must be an origin-form target, not a URL supplied by a client.
function parseWebSocketRequestUrl(requestUrl) {
  if (
    typeof requestUrl !== 'string'
    || !requestUrl.startsWith('/')
    || requestUrl.startsWith('//')
    || /[\u0000-\u0020\u007f\\#]/u.test(requestUrl)
  ) {
    return null;
  }

  try {
    // WHATWG URL tolerates malformed escapes/UTF-8; do not silently repair them.
    decodeURI(requestUrl);
    const parsed = new URL(requestUrl, REQUEST_BASE);
    const rawPathname = requestUrl.split('?', 1)[0];
    // In particular, dot-segment normalization must not create an accepted route.
    if (parsed.origin !== REQUEST_BASE || parsed.pathname !== rawPathname) return null;

    const query = Object.create(null);
    for (const name of SECURITY_QUERY_PARAMETERS) {
      const values = parsed.searchParams.getAll(name);
      // Legacy parsing returned arrays for duplicates, which could not match claims.
      // Never turn that rejection into acceptance by selecting the first value.
      if (values.length > 1) return null;
      query[name] = values[0];
    }
    return { pathname: parsed.pathname, query };
  } catch {
    return null;
  }
}

module.exports = { parseWebSocketRequestUrl };