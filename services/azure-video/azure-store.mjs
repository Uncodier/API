// Node built-ins only. Resources must already exist; this adapter never provisions them.
// createAzureStore({ accountName, clientId, identity: 'container-apps' | 'imds',
//   identityEndpoint?, identityHeader?, fetchImpl?, now?, timeoutMs?,
//   maxVisibilitySeconds? }). Container Apps defaults come from IDENTITY_*.
// get/put store JSON in jobs. receive({visibilitySeconds?, maxMessages?}) returns
// [{messageId, popReceipt, jobId, dequeueCount}]; acknowledge with deleteMessage.
// getContent returns {body: Buffer, contentType} or null. IDs are single segments.

export const MAX_CONTENT_BYTES = 100 * 1024 * 1024;
export const MAX_VISIBILITY_SECONDS = 7 * 24 * 60 * 60;
const API_VERSION = '2023-11-03';
const RESOURCE = 'https://storage.azure.com/';
const JSON_LIMIT = 1024 * 1024;

export class AzureStoreError extends Error {
  constructor(code, status) {
    super(`Azure storage operation failed (${code})`);
    this.name = 'AzureStoreError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
const fail = (code, status) => { throw new AzureStoreError(code, status); };
const valid = (condition) => { if (!condition) fail('INVALID_ARGUMENT'); };
const segment = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(value);
const headerValue = value => typeof value === 'string' && /^[\x20-\x7e]{1,2048}$/.test(value);
function keyPath(key) {
  valid(typeof key === 'string' && key.length <= 1024 && key.split('/').every(segment));
  return key;
}
function idPath(id) { valid(segment(id)); return id; }

// Azure's Queue REST subset needs no general XML parser. Never resolve DTDs or
// external entities; reject unsupported/malformed entities instead of guessing.
function xmlText(text) {
  if (/[<>]/.test(text) || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) fail('INVALID_RESPONSE');
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(known, entity)) return known[entity];
    const n = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(n) || n < 32 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) fail('INVALID_RESPONSE');
    return String.fromCodePoint(n);
  });
}
function parseMessages(xml, maximum) {
  const root = xml.trim().replace(/^<\?xml\s+version="1\.0"(?:\s+encoding="utf-8")?\s*\?>\s*/i, '');
  if (/^<QueueMessagesList\s*\/>$/.test(root)) return [];
  const match = /^<QueueMessagesList>([\s\S]*)<\/QueueMessagesList>$/.exec(root);
  if (!match) fail('INVALID_RESPONSE');
  const result = [];
  let rest = match[1].trim();
  while (rest) {
    const message = /^<QueueMessage>([\s\S]*?)<\/QueueMessage>\s*/.exec(rest);
    if (!message || result.length >= maximum) fail('INVALID_RESPONSE');
    const fields = {};
    let inner = message[1].trim();
    while (inner) {
      const field = /^<(MessageId|InsertionTime|ExpirationTime|PopReceipt|TimeNextVisible|DequeueCount|MessageText)>([^<]*)<\/\1>\s*/.exec(inner);
      if (!field || Object.hasOwn(fields, field[1])) fail('INVALID_RESPONSE');
      fields[field[1]] = xmlText(field[2]);
      inner = inner.slice(field[0].length);
    }
    const encoded = fields.MessageText;
    if (typeof encoded !== 'string' || encoded.length > 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('INVALID_RESPONSE');
    const decoded = Buffer.from(encoded, 'base64');
    const jobId = decoded.toString('utf8');
    if (decoded.toString('base64') !== encoded || !segment(jobId) || !segment(fields.MessageId) ||
        !headerValue(fields.PopReceipt) || !/^[1-9]\d*$/.test(fields.DequeueCount) ||
        !Number.isSafeInteger(Number(fields.DequeueCount))) fail('INVALID_RESPONSE');
    result.push({ messageId: fields.MessageId, popReceipt: fields.PopReceipt, jobId, dequeueCount: Number(fields.DequeueCount) });
    rest = rest.slice(message[0].length);
  }
  return result;
}

function createRequest(fetchImpl, timeoutMs) {
  // Deadline covers both headers and consumption, including a stalled body. Never
  // expose fetch errors, response bodies, URLs, credentials, or nested causes.
  return async function request(url, options, statuses, limit) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
          if (response.redirected || (response.status >= 300 && response.status < 400)) fail('REDIRECT_REJECTED');
          if (!statuses.includes(response.status)) {
            const code = [409, 412].includes(response.status) ? 'CAS_CONFLICT' : 'HTTP_ERROR';
            fail(code, response.status);
          }
          const chunks = [];
          let size = 0;
          if (response.body) {
            const reader = response.body.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > limit) fail('RESPONSE_TOO_LARGE');
                chunks.push(Buffer.from(value));
              }
            } finally { reader.releaseLock(); }
          }
          return { status: response.status, headers: response.headers, body: Buffer.concat(chunks, size) };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new AzureStoreError('TIMEOUT'));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      controller.abort();
      if (error instanceof AzureStoreError) throw error;
      fail('REQUEST_FAILED');
    } finally { clearTimeout(timer); }
  }
}

// Each provider has an isolated, single-flight cache for one allowlisted audience.
export function createManagedIdentityTokenProvider({
  resource = RESOURCE, clientId = process.env.AZURE_CLIENT_ID,
  identity = 'container-apps', identityEndpoint = process.env.IDENTITY_ENDPOINT,
  identityHeader = process.env.IDENTITY_HEADER, fetchImpl = globalThis.fetch,
  now = Date.now, timeoutMs = 15_000,
} = {}) {
  valid([RESOURCE, 'https://management.azure.com/'].includes(resource));
  valid(typeof clientId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientId));
  valid(typeof fetchImpl === 'function' && typeof now === 'function');
  valid(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120_000);
  valid(identity === 'container-apps' || identity === 'imds');
  let tokenURL;
  if (identity === 'container-apps') {
    try { tokenURL = new URL(identityEndpoint); } catch { fail('INVALID_ARGUMENT'); }
    valid(tokenURL.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(tokenURL.hostname) &&
      !tokenURL.username && !tokenURL.password && !tokenURL.search && !tokenURL.hash && tokenURL.pathname === '/msi/token');
    valid(headerValue(identityHeader));
    tokenURL.searchParams.set('api-version', '2019-08-01');
  } else {
    // IMDS is never a fallback: callers must explicitly select it. No URL override.
    tokenURL = new URL('http://169.254.169.254/metadata/identity/oauth2/token');
    tokenURL.searchParams.set('api-version', '2018-02-01');
  }
  tokenURL.searchParams.set('resource', resource);
  tokenURL.searchParams.set('client_id', clientId);
  let cached, pending;

  const request = createRequest(fetchImpl, timeoutMs);
  async function token() {
    if (cached && cached.expires > now() + 60_000) return cached.value;
    if (!pending) {
      pending = (async () => {
        const headers = identity === 'imds' ? { Metadata: 'true' } : { 'X-IDENTITY-HEADER': identityHeader };
        const response = await request(tokenURL.href, { method: 'GET', headers }, [200], 64 * 1024);
        let data;
        try { data = JSON.parse(response.body.toString('utf8')); } catch { fail('INVALID_TOKEN'); }
        const expires = data && /^\d+(?:\.\d+)?$/.test(String(data.expires_on)) ? Number(data.expires_on) * 1000 : NaN;
        if (!data || typeof data.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(data.access_token) ||
            data.access_token.length > 16_384 || !Number.isFinite(expires) || expires <= now() + 60_000 ||
            (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'))) fail('INVALID_TOKEN');
        cached = { value: data.access_token, expires };
        return cached.value;
      })().finally(() => { pending = undefined; });
    }
    return pending;
  }
  return token;
}

export function createAzureStore({
  accountName, clientId = process.env.AZURE_CLIENT_ID,
  identity = 'container-apps', identityEndpoint = process.env.IDENTITY_ENDPOINT,
  identityHeader = process.env.IDENTITY_HEADER, fetchImpl = globalThis.fetch,
  now = Date.now, timeoutMs = 15_000, maxVisibilitySeconds = 300,
} = {}) {
  valid(typeof accountName === 'string' && /^[a-z0-9]{3,24}$/.test(accountName));
  valid(Number.isInteger(maxVisibilitySeconds) && maxVisibilitySeconds >= 1 && maxVisibilitySeconds <= MAX_VISIBILITY_SECONDS);
  const token = createManagedIdentityTokenProvider({
    clientId, identity, identityEndpoint, identityHeader, fetchImpl, now, timeoutMs, resource: RESOURCE,
  });
  const request = createRequest(fetchImpl, timeoutMs);
  const blobBase = `https://${accountName}.blob.core.windows.net`;
  const queueBase = `https://${accountName}.queue.core.windows.net/video-jobs/messages`;
  async function storage(url, method, headers = {}, body, statuses = [200], limit = JSON_LIMIT) {
    const accessToken = await token();
    const response = await request(url, { method, headers: {
      ...headers, Authorization: `Bearer ${accessToken}`, 'x-ms-version': API_VERSION,
    }, body }, statuses, limit);
    return response;
  }
  function etag(response) {
    const value = response.headers.get('etag');
    if (!headerValue(value)) fail('INVALID_RESPONSE');
    return value;
  }
  return Object.freeze({
    async get(key) {
      const response = await storage(`${blobBase}/jobs/${keyPath(key)}`, 'GET', {}, undefined, [200, 404]);
      if (response.status === 404) return null;
      let value;
      try { value = JSON.parse(response.body.toString('utf8')); } catch { fail('INVALID_RESPONSE'); }
      return { value, etag: etag(response) };
    },
    async put(key, value, { ifNoneMatch, etag: match } = {}) {
      const url = `${blobBase}/jobs/${keyPath(key)}`;
      valid(ifNoneMatch === undefined || ifNoneMatch === true || ifNoneMatch === '*');
      valid(match === undefined || headerValue(match));
      valid(ifNoneMatch === undefined || match === undefined);
      let body;
      try { body = JSON.stringify(value); } catch { fail('INVALID_ARGUMENT'); }
      valid(typeof body === 'string' && Buffer.byteLength(body) <= JSON_LIMIT);
      const headers = { 'Content-Type': 'application/json', 'x-ms-blob-type': 'BlockBlob' };
      if (ifNoneMatch !== undefined) headers['If-None-Match'] = '*';
      if (match !== undefined) headers['If-Match'] = match;
      return { etag: etag(await storage(url, 'PUT', headers, body, [201])) };
    },
    async enqueue(jobId) {
      idPath(jobId);
      const body = `<QueueMessage><MessageText>${Buffer.from(jobId, 'utf8').toString('base64')}</MessageText></QueueMessage>`;
      await storage(queueBase, 'POST', { 'Content-Type': 'application/xml; charset=utf-8' }, body, [201]);
    },
    async receive({ visibilitySeconds = Math.min(30, maxVisibilitySeconds), maxMessages = 1 } = {}) {
      valid(Number.isInteger(visibilitySeconds) && visibilitySeconds >= 1 && visibilitySeconds <= maxVisibilitySeconds);
      valid(Number.isInteger(maxMessages) && maxMessages >= 1 && maxMessages <= 32);
      const url = new URL(queueBase);
      url.searchParams.set('visibilitytimeout', String(visibilitySeconds));
      url.searchParams.set('numofmessages', String(maxMessages));
      const response = await storage(url.href, 'GET');
      return parseMessages(response.body.toString('utf8'), maxMessages);
    },
    async deleteMessage(messageId, popReceipt) {
      idPath(messageId);
      valid(headerValue(popReceipt));
      const url = new URL(`${queueBase}/${messageId}`);
      url.searchParams.set('popreceipt', popReceipt);
      await storage(url.href, 'DELETE', {}, undefined, [204]);
    },
    async uploadContent(id, bytes) {
      const url = `${blobBase}/videos/${idPath(id)}.mp4`;
      valid(bytes instanceof Uint8Array && bytes.byteLength <= MAX_CONTENT_BYTES);
      return { etag: etag(await storage(url, 'PUT', {
        'Content-Type': 'video/mp4', 'x-ms-blob-type': 'BlockBlob',
      }, bytes, [201])) };
    },
    async getContent(id) {
      const response = await storage(`${blobBase}/videos/${idPath(id)}.mp4`, 'GET', {}, undefined, [200, 404], MAX_CONTENT_BYTES);
      if (response.status === 404) return null;
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      if (!headerValue(contentType)) fail('INVALID_RESPONSE');
      return { body: response.body, contentType };
    },
  });
}