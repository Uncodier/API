import { NextResponse } from 'next/server';
import { isValidUUID } from '@/lib/agentbase/utils/UuidUtils';
import { authorizeFinderCreate, FinderError, finderFailure, requireFinderActor, requireFinderPermission } from './ownership';

const MAX_BODY_BYTES = 40000;

async function readBody(request: Request, create: boolean) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new FinderError(413, 'Request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new FinderError(400, 'A JSON body is required.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new FinderError(413, 'Request body is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: Record<string, unknown>;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new FinderError(400, 'Invalid JSON body.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FinderError(400, 'Expected a JSON object.');
  const allowed = create ? ['site_id', 'name', 'person_ids', 'request_id'] : ['site_id', 'person_ids', 'request_id'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new FinderError(400, 'Unexpected request field.');
  if (typeof body.site_id !== 'string' || !isValidUUID(body.site_id) ||
      typeof body.request_id !== 'string' || !isValidUUID(body.request_id)) throw new FinderError(400, 'Valid site_id and request_id UUIDs are required.');
  if (!Array.isArray(body.person_ids) || body.person_ids.length < 1 || body.person_ids.length > 100 ||
      body.person_ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id))) {
    throw new FinderError(400, 'Provide between 1 and 100 valid provider person IDs.');
  }
  if (create && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200 || /[\x00-\x1f\x7f]/.test(body.name))) {
    throw new FinderError(400, 'A list name of 1 to 200 characters is required.');
  }
  return { siteId: body.site_id, requestId: body.request_id, personIds: body.person_ids as string[], name: typeof body.name === 'string' ? body.name.trim() : undefined };
}

/** Each entry authenticates independently; mutations use only the user's client. */
export async function persistSelectedList(request: Request, listId?: string) {
  try {
    const { client, userId } = await requireFinderActor(request);
    if (listId !== undefined && !isValidUUID(listId)) throw new FinderError(400, 'Invalid list ID.');
    const body = await readBody(request, listId === undefined);
    if (listId === undefined) {
      await authorizeFinderCreate(client, body.siteId, userId);
    } else {
      const { data, error } = await client.from('icp_mining').select('id,site_id').eq('id', listId).eq('site_id', body.siteId).maybeSingle();
      if (error) throw new FinderError(503, 'Finder authorization is unavailable.');
      if (!data) throw new FinderError(404, 'List not found.');
      await requireFinderPermission(client, data.site_id, 'update');
    }
    const { data, error } = await client.rpc(listId === undefined ? 'finder_create_selected_list' : 'finder_append_selected_people', {
      p_site_id: body.siteId, p_person_ids: body.personIds, p_request_id: body.requestId,
      ...(listId === undefined ? { p_name: body.name } : { p_list_id: listId }),
    });
    if (error) {
      const status = error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : error.code === '22023' ? 400 : error.code === '23505' ? 409 : 503;
      throw new FinderError(status, status === 409 ? 'Request ID was already used for a different operation.' : 'Selected list operation could not be completed.');
    }
    if (!data?.list?.id || !Number.isInteger(data.added_count)) throw new FinderError(503, 'Selected list operation could not be completed.');
    const { id, site_id, name, status, total_targets, created_at } = data.list;
    return NextResponse.json({ list: { id, site_id, name, status, total_targets, created_at }, added_count: data.added_count }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return finderFailure(error); }
}