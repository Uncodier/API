import { NextResponse } from 'next/server';
import { getOutstandClient } from './client';
import { deleteOwnedPost } from './post-deletion';
import { OutstandPostError } from './post-errors';
import { getOwnedPost } from './post-ownership';
import { parsePostRequest, requirePostSiteAccess } from './post-request';
import { publicPost } from './post-response';

export type PostRouteContext = { params: Promise<{ id: string }> };

export async function handlePostRequest(request: Request, context: PostRouteContext, remoteOnly = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70_000);
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const signal = controller.signal;
  let rejectOnAbort: () => void = () => {};
  try {
    const timeout = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(new OutstandPostError(502,
        'Deletion or verification timed out. Keep local content and inspect Outstand before retrying.'));
      signal.addEventListener('abort', rejectOnAbort, { once: true });
      if (signal.aborted) rejectOnAbort();
    });
    const operation = async () => {
      const { id } = await context.params;
      signal.throwIfAborted();
      const { siteId, deleteRemote } = parsePostRequest(request, id, remoteOnly);
      await requirePostSiteAccess(request, siteId, signal);
      signal.throwIfAborted();
      const client = getOutstandClient(signal);
      const post = await getOwnedPost(client, id, siteId);
      signal.throwIfAborted();
      // Next may invoke GET for HEAD without rewriting request.method. Mutation is opt-in.
      return request.method === 'DELETE' ? deleteOwnedPost(client, post, siteId, deleteRemote)
        : { success: true, post: publicPost(post) };
    };
    return NextResponse.json(await Promise.race([operation(), timeout]), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const safe = error instanceof OutstandPostError ? error
      : new OutstandPostError(502, 'Unable to confirm this operation. Keep local content and contact support.');
    return NextResponse.json({ success: false, error: safe.message }, {
      status: safe.status, headers: { 'Cache-Control': 'no-store' },
    });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    signal.removeEventListener('abort', rejectOnAbort);
  }
}