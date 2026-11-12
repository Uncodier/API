import { randomBytes, randomUUID } from 'node:crypto';
import { encryptCredential, decryptCredential } from '../crypto';
import { compatibility, discoverCatalog, emptyCapabilities, evaluateCapabilities, normalizeCatalog } from '../catalog';
import { mutationSchema } from '../validation';
import { rolloutEnabled } from '../types';
const siteId = randomUUID(), id = randomUUID();
const apiKey = randomBytes(32).toString('hex');
const catalog = { data: [{ id: 'vendor/model', name: 'Model', architecture: { input_modalities: ['text','image'], output_modalities: ['text','image'] }, supported_parameters: ['tools','structured_outputs'], context_length: 32000 }] };
afterEach(() => { jest.restoreAllMocks(); delete process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY; });
test('AES-GCM round trip uses randomized ciphertext and authenticated site/id/version', () => {
  process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const encrypted = encryptCredential(apiKey, siteId, id, 1);
  expect(encrypted).not.toContain(apiKey);
  expect(encryptCredential(apiKey, siteId, id, 1)).not.toBe(encrypted);
  expect(decryptCredential(encrypted, siteId, id, 1)).toBe(apiKey);
  for (const ref of [[randomUUID(),id,1],[siteId,randomUUID(),1],[siteId,id,2]] as const) {
    expect(() => decryptCredential(encrypted, ref[0], ref[1], ref[2])).toThrow('could not be decrypted');
  }
  const parts = encrypted.split('.'); const ciphertext = Buffer.from(parts[3], 'base64'); ciphertext[0] ^= 1; parts[3] = ciphertext.toString('base64');
  expect(() => decryptCredential(parts.join('.'), siteId, id, 1)).toThrow('could not be decrypted');
});
test('missing or malformed encryption secret never uses unrelated fallback keys', () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.OPENROUTER_API_KEY = apiKey;
  for (const value of [undefined,'',randomBytes(8).toString('base64')]) {
    if (value === undefined) delete process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY = value;
    expect(() => encryptCredential(apiKey, siteId, id, 1)).toThrow('not configured');
  }
  delete process.env.ENCRYPTION_KEY; delete process.env.OPENROUTER_API_KEY;
});
test('catalog is bounded, strips provider extras, rejects partial and duplicate data', () => {
  expect(normalizeCatalog(catalog)[0]).toMatchObject({ id: 'vendor/model', contextLength: 32000 });
  for (const data of [{}, { data: [catalog.data[0], {}] }, { data: [catalog.data[0],catalog.data[0]] }, {data:[{...catalog.data[0],id:'https://evil.test?key=value'}]}]) {
    expect(() => normalizeCatalog(data)).toThrow();
  }
  expect(normalizeCatalog({ data: [] })).toEqual([]);
});
test('free validation uses only fixed key and account-filtered all-modality catalog GETs', async () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ data: { is_free_tier: false } })).mockResolvedValueOnce(Response.json(catalog));
  await expect(discoverCatalog(apiKey)).resolves.toHaveLength(1);
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/models/user?output_modalities=all']);
  for (const [,options] of fetchMock.mock.calls) expect(options).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', headers: { Authorization: `Bearer ${apiKey}` } });
});
test('provider failures are redacted and never interpreted as empty catalog', async () => {
  jest.spyOn(globalThis,'fetch').mockRejectedValue(new Error(apiKey));
  await expect(discoverCatalog(apiKey)).rejects.toMatchObject({ code: 'catalog_unavailable', message: 'OpenRouter catalog could not be validated' });
});
test('catalog compatible text is unverified; images, media and embedding space are not enabled', () => {
  const model = normalizeCatalog(catalog)[0];
  for (const key of ['text','tools','structured','vision','summary'] as const) expect(compatibility(key,model).status).toBe('unverified');
  for (const key of ['image','speech','transcription','video','embedding'] as const) expect(compatibility(key,model).status).toBe('unavailable');
});
test('refresh preserves exact pins and disabled policy, marks missing pin unavailable', () => {
  const pins = emptyCapabilities(); pins.text = { mode: 'manual', modelId: 'vendor/model', status: 'unverified', reason: '' };
  pins.image.modelId = 'vendor/model';
  expect(evaluateCapabilities(pins,[]).text).toMatchObject({ mode: 'manual', modelId: 'vendor/model', status: 'unavailable' });
  expect(evaluateCapabilities(pins,normalizeCatalog(catalog)).image).toMatchObject({ mode: 'disabled', modelId: 'vendor/model', status: 'disabled' });
});
test('schema accepts routing modes but rejects client evidence, identities and URLs', () => {
  const input = { operation: 'configure', siteId, expectedRevision: 1, capabilities: { text: { mode: 'manual', modelId: 'vendor/model' } } };
  expect(mutationSchema.safeParse(input).success).toBe(true);
  for (const extra of [{userId:randomUUID()},{paid:true},{providerUrl:'https://example.test'}]) expect(mutationSchema.safeParse({...input,...extra}).success).toBe(false);
  expect(mutationSchema.safeParse({...input,capabilities:{image:{mode:'manual',modelId:'vendor/model',status:'available'}}}).success).toBe(false);
  expect(mutationSchema.safeParse({...input,capabilities:{text:{mode:'automatic'}}}).success).toBe(true);
  expect(mutationSchema.safeParse({...input,capabilities:{text:{mode:'automatic',recommendation:{modelId:'vendor/model'}}}}).success).toBe(false);
  process.env.CUSTOMER_OPENROUTER_ENABLED = 'true'; expect(rolloutEnabled()).toBe(false); delete process.env.CUSTOMER_OPENROUTER_ENABLED;
});
