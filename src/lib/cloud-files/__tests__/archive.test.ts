import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { archiveCloudRevision } from '../archive';
import type { CloudRevision, CloudScope } from '../types';

const scope: CloudScope = { siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID() };
function revision(content = '\ufeffPrivate café\r\n\t日本語\n'): CloudRevision {
  return { file_id: randomUUID(), version: 2, name: 'source.md', mime: 'text/markdown', content,
    bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
    instance_id: scope.instanceId, requirement_id: null, git_status: 'pending' };
}

test('private archive contains only exact canonical UTF-8 bytes, including BOM and CRLF', async () => {
  const document = revision();
  const store = { read: jest.fn(async () => document) };
  const assertActive = jest.fn(async () => {});
  const buffer = await archiveCloudRevision(scope, document, { store, assertActive });
  const zip = await JSZip.loadAsync(buffer);
  expect(Object.keys(zip.files)).toEqual(['source.md']);
  expect(await zip.file('source.md')!.async('nodebuffer')).toEqual(Buffer.from(document.content));
  expect(store.read).toHaveBeenCalledWith(scope, document.file_id, 2);
  expect(assertActive).toHaveBeenCalledTimes(2);
});

test('does not trust caller bytes or a different tenant/requirement revision', async () => {
  const document = revision();
  await expect(archiveCloudRevision(scope, { ...document, content: 'tampered' }, {
    store: { read: async () => document },
  })).rejects.toMatchObject({ code: 'invalid_revision' });
  await expect(archiveCloudRevision(scope, document, {
    store: { read: async () => ({ ...document, instance_id: randomUUID() }) },
  })).rejects.toMatchObject({ code: 'invalid_revision' });
  await expect(archiveCloudRevision({ ...scope, requirementId: randomUUID() }, document, {
    store: { read: async () => document },
  })).rejects.toMatchObject({ code: 'invalid_revision' });
});

test.each(['../private.md', '/absolute.md', 'a\\b.md', 'a/../b.md', '.git/config', '.github/workflows/run.yml', 'C:drive', 'NUL.txt', 'name.'])('rejects unsafe archive entry %s', async name => {
  const document = { ...revision(), name };
  await expect(archiveCloudRevision(scope, document, { store: { read: async () => document } }))
    .rejects.toMatchObject({ code: 'invalid_revision' });
});

test('honors loss of execution authority after archive creation', async () => {
  const document = revision();
  let calls = 0;
  await expect(archiveCloudRevision(scope, document, {
    store: { read: async () => document },
    assertActive: async () => { if (++calls === 2) throw new Error('inactive'); },
  })).rejects.toMatchObject({ code: 'inactive' });
});