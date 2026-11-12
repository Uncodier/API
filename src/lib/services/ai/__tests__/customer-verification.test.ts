import { randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { verifyCustomerImage, type CustomerImageVerificationInput } from '../customer-verification';
import { persistCustomerImage } from '../customer-image-persistence';

jest.mock('../customer-image-persistence', () => ({ persistCustomerImage: jest.fn() }));

function png() {
  const chunk = (type: string, payload: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), payload]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i=0;i<8;i++) crc=(crc>>>1)^(crc&1?0xedb88320:0); }
    const size=Buffer.alloc(4); size.writeUInt32BE(payload.length);
    const checksum=Buffer.alloc(4); checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([size,body,checksum]);
  };
  const header=Buffer.alloc(13); header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.alloc(4))),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}

describe('explicitly consented bounded image verification runner (offline)', () => {
  const oldFetch=global.fetch;
  const input: CustomerImageVerificationInput={apiKey:randomBytes(24).toString('hex'),modelId:'vendor/image',
    siteId:randomUUID(),connectionId:randomUUID(),credentialVersion:1,policyVersion:1,operationId:randomUUID(),
    consent:true,maxCostUsd:0.1,maximumQuotedCostUsd:0.05,providerTag:'vendor'};
  beforeEach(()=>{jest.clearAllMocks();global.fetch=jest.fn();
    jest.mocked(persistCustomerImage).mockResolvedValue({url:'https://example.test/image.png',b64_json:null,
      artifact_id:input.operationId as ReturnType<typeof randomUUID>,receipt_event_id:input.operationId});});
  afterAll(()=>{global.fetch=oldFetch;});
  it.each([{consent:false},{maxCostUsd:0},{maxCostUsd:Infinity},{maximumQuotedCostUsd:NaN},
    {maximumQuotedCostUsd:0.2}])('blocks missing consent or unbounded quote before network',async patch=>{
    await expect(verifyCustomerImage({...input,...patch} as CustomerImageVerificationInput)).rejects.toThrow('fallback is prohibited');
    expect(global.fetch).not.toHaveBeenCalled();expect(persistCustomerImage).not.toHaveBeenCalled();
  });
  it('accepts only actual complete artifact, cost, serving model and persisted linkage',async()=>{
    jest.mocked(global.fetch).mockResolvedValue(Response.json({id:'gen-1',model:'vendor/image',usage:{cost:0.05},data:[{b64_json:png()}]}));
    const result=await verifyCustomerImage(input);
    expect(result).toMatchObject({artifactId:input.operationId,receiptEventId:input.operationId,actualModel:'vendor/image'});
    expect(persistCustomerImage).toHaveBeenCalledWith(expect.objectContaining({eventId:input.operationId,siteId:input.siteId}));
    expect(global.fetch).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain(input.apiKey);
  });
  it.each([{data:[]},{data:[{url:'https://example.test/a.png'}]},
    {data:[{b64_json:png()}],usage:{}},{data:[{b64_json:png()}],usage:{cost:2}}])('rejects false successful response without replay',async value=>{
    jest.mocked(global.fetch).mockResolvedValue(Response.json({id:'gen-1',model:'vendor/image',...value}));
    await expect(verifyCustomerImage(input)).rejects.toThrow('do not replay');
    expect(global.fetch).toHaveBeenCalledTimes(1);expect(persistCustomerImage).not.toHaveBeenCalled();
  });
  it('does not publish success when persistence fails',async()=>{
    jest.mocked(global.fetch).mockResolvedValue(Response.json({id:'gen-1',model:'vendor/image',usage:{cost:0.05},data:[{b64_json:png()}]}));
    jest.mocked(persistCustomerImage).mockRejectedValue(new Error('storage failed'));
    await expect(verifyCustomerImage(input)).rejects.toThrow('do not replay');expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});