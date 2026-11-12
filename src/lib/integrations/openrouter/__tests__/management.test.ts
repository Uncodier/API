import { randomBytes, randomUUID } from 'node:crypto';
import { emptyCapabilities } from '../catalog';
import { connectionDto, mutateConnection } from '../management';
import * as store from '../store';
import * as catalog from '../catalog';
import { type ConnectionRow, OpenRouterError } from '../types';
import { encryptCredential } from '../crypto';
jest.mock('../store', () => ({ readConnection: jest.fn(), publishConnection: jest.fn(), claimRefresh: jest.fn(), releaseRefresh: jest.fn() }));
jest.mock('../catalog', () => ({ ...jest.requireActual('../catalog'), discoverCatalog: jest.fn() }));
const actor = randomUUID(), siteId = randomUUID(), id = randomUUID();
const apiKey = randomBytes(32).toString('hex');
const model = { id: 'vendor/model', name: 'Model', inputModalities:['text'], outputModalities:['text'], supportedParameters:[], contextLength:32000 };
function row(): ConnectionRow { return { id, site_id:siteId, status:'connected', selected:false, revision:1, policy_version:1, credential_version:1, encrypted_credential:'private', capabilities:emptyCapabilities(), catalog:[model], catalog_updated_at:'now', verified_at:'now', consent_at:'now', updated_at:'now' }; }
beforeEach(() => {
  jest.clearAllMocks(); process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  jest.mocked(store.readConnection).mockResolvedValue(row());
  jest.mocked(store.publishConnection).mockImplementation(async (_site,_actor,_revision,candidate) => candidate);
  jest.mocked(store.releaseRefresh).mockResolvedValue();
});
afterEach(() => { delete process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY; });
test('DTO allowlists safe fields, excludes cipher/catalog and key', () => {
  const value = JSON.stringify(connectionDto({...row(),encrypted_credential:apiKey}));
  expect(value).not.toContain(apiKey); expect(value).not.toContain('encrypted_credential'); expect(value).not.toContain('catalog":');
  expect(connectionDto(null)).toMatchObject({ connection:null, rolloutEnabled:false, paidSelectionEnabled:true });
});
test('connect validates key and catalog before one CAS encrypted publication; remains deselected', async () => {
  jest.mocked(store.readConnection).mockResolvedValue(null); jest.mocked(catalog.discoverCatalog).mockResolvedValue([model]);
  await mutateConnection(actor,{operation:'connect',siteId,expectedRevision:0,apiKey,consent:true});
  const candidate = jest.mocked(store.publishConnection).mock.calls[0][3];
  expect(candidate.selected).toBe(false); expect(candidate.credential_version).toBe(1); expect(candidate.encrypted_credential).not.toContain(apiKey);
  expect(candidate.capabilities.text.mode).toBe('disabled');
  expect(store.publishConnection).toHaveBeenCalledWith(siteId,actor,0,expect.any(Object));
});
test('failed free validation does not overwrite previous connection', async () => {
  jest.mocked(catalog.discoverCatalog).mockRejectedValue(new Error('upstream'));
  await expect(mutateConnection(actor,{operation:'connect',siteId,expectedRevision:1,apiKey,consent:true})).rejects.toThrow();
  expect(store.publishConnection).not.toHaveBeenCalled();
});
test('stale revision and activation reject before provider or publication', async () => {
  await expect(mutateConnection(actor,{operation:'refresh',siteId,expectedRevision:0})).rejects.toMatchObject({status:409});
  await expect(mutateConnection(actor,{operation:'configure',siteId,expectedRevision:1,selected:true})).rejects.toMatchObject({code:'OPENROUTER_RUNTIME_NOT_READY'});
  expect(store.publishConnection).not.toHaveBeenCalled(); expect(catalog.discoverCatalog).not.toHaveBeenCalled();
});
test('manual exact model saved; incompatible image unavailable, new missing pin rejected', async () => {
  await mutateConnection(actor,{operation:'configure',siteId,expectedRevision:1,capabilities:{text:{mode:'manual',modelId:model.id},image:{mode:'manual',modelId:model.id}}});
  expect(jest.mocked(store.publishConnection).mock.calls[0][3].capabilities).toMatchObject({text:{modelId:model.id,status:'unverified'},image:{status:'unavailable'}});
  await expect(mutateConnection(actor,{operation:'configure',siteId,expectedRevision:1,capabilities:{text:{mode:'manual',modelId:'other/model'}}})).rejects.toMatchObject({code:'invalid_model'});
});
test('rejects incompatible combined policy before publication without forcing equal model pins',async()=>{
  const current=row();
  current.catalog=[{...model,id:'vendor/tools',supportedParameters:['tools']},{...model,id:'vendor/structured',supportedParameters:['structured_outputs']}];
  jest.mocked(store.readConnection).mockResolvedValue(current);
  const input={operation:'configure' as const,siteId,expectedRevision:1,capabilities:{tools:{mode:'manual' as const,modelId:'vendor/tools'},structured:{mode:'manual' as const,modelId:'vendor/structured'}}};
  await expect(mutateConnection(actor,input)).rejects.toMatchObject({code:'combined_capability_unsupported'});
  expect(store.publishConnection).not.toHaveBeenCalled();
  current.catalog[0].supportedParameters.push('structured_outputs');
  await mutateConnection(actor,input);
  expect(store.publishConnection).toHaveBeenCalledWith(siteId,actor,1,expect.objectContaining({capabilities:expect.objectContaining({tools:expect.objectContaining({modelId:'vendor/tools'}),structured:expect.objectContaining({modelId:'vendor/structured'})})}));
});
test('disconnect erases credential, revokes selected and increments credential version under CAS', async () => {
  await mutateConnection(actor,{operation:'disconnect',siteId,expectedRevision:1});
  expect(jest.mocked(store.publishConnection).mock.calls[0][3]).toMatchObject({status:'disconnected',selected:false,credential_version:2,encrypted_credential:null,catalog:[]});
});
test('refresh deduplication rejects before decryption or provider read', async () => {
  jest.mocked(store.claimRefresh).mockRejectedValue(new Error('busy'));
  await expect(mutateConnection(actor,{operation:'refresh',siteId,expectedRevision:1})).rejects.toThrow('busy');
  expect(catalog.discoverCatalog).not.toHaveBeenCalled();
});

test('refresh preserves pins and last snapshot, releases lease when concurrent publication wins', async () => {
  const current = row(); current.encrypted_credential = encryptCredential(apiKey,siteId,id,1);
  current.capabilities.text = {mode:'manual',modelId:model.id,status:'unverified',reason:'manual'};
  jest.mocked(store.readConnection).mockResolvedValue(current);
  jest.mocked(store.claimRefresh).mockResolvedValue();
  jest.mocked(catalog.discoverCatalog).mockResolvedValue([]);
  jest.mocked(store.publishConnection).mockRejectedValue(new OpenRouterError('revision_conflict','Reload',409));
  await expect(mutateConnection(actor,{operation:'refresh',siteId,expectedRevision:1})).rejects.toMatchObject({status:409});
  expect(jest.mocked(store.publishConnection).mock.calls[0][3].capabilities.text).toMatchObject({modelId:model.id,mode:'manual',status:'unavailable'});
  expect(store.publishConnection).toHaveBeenCalledTimes(1);
  expect(store.releaseRefresh).toHaveBeenCalledWith(siteId,expect.any(String));
  expect(current.capabilities.text.status).toBe('unverified');
});
test('refresh upstream failure does not publish removals and releases owned lease', async () => {
  const current=row();current.encrypted_credential=encryptCredential(apiKey,siteId,id,1);
  jest.mocked(store.readConnection).mockResolvedValue(current);jest.mocked(store.claimRefresh).mockResolvedValue();
  jest.mocked(catalog.discoverCatalog).mockRejectedValue(new OpenRouterError('catalog_unavailable','Unavailable',502));
  await expect(mutateConnection(actor,{operation:'refresh',siteId,expectedRevision:1})).rejects.toMatchObject({status:502});
  expect(store.publishConnection).not.toHaveBeenCalled();expect(store.releaseRefresh).toHaveBeenCalledTimes(1);
});
