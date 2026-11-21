import { randomBytes } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { findToolArgumentIssue as check, argumentFailure } from '@/lib/tools/argument-contract';
import { validateConnectorInput } from '../schema-validation';
import { failureForAgent } from '../agent-recovery';
import { ConnectorError } from '../types';

const field = (s: unknown) => ({type:'object',properties:{items:{type:'array',items:s}},additionalProperties:false});
const bad = (schema:unknown,args:unknown) => {
  try { validateConnectorInput(schema,args); } catch(e) { return failureForAgent(Object.assign(e as Error,{effectStarted:false})); }
  throw new Error('Expected predispatch validation failure');
};

it('uses nested schema fields and array positions but never submitted keys, values, descriptions or choices',()=>{
  const secret=randomBytes(32).toString('hex');
  const s=field({type:'object',properties:{label:{type:'string',enum:[secret],description:secret}},required:['label'],additionalProperties:false});
  for(const [args,path,rule] of [[{items:[{}]},'arguments.items[0].label','required'],
    [{items:[{label:secret},{label:7}]},'arguments.items[1].label','type'],
    [{items:[{label:'submitted-private-value'}]},'arguments.items[0].label','enum'],
    [{items:[{label:secret,[secret]:42}]},'arguments.items[0]','extra']] as const){
    const failure=bad(s,args);
    expect(failure).toMatchObject({code:'INVALID_TOOL_ARGUMENTS',executed:false,automatic_retry:false,argument_issue:{path,rule},recovery:{action:'fix_arguments'}});
    expect(JSON.stringify(failure)).not.toContain(secret);expect(JSON.stringify(failure)).not.toContain('submitted-private-value');
  }
  expect(check(s,{items:[{label:secret}]})).toBeNull();
});

it('handles nullable, unions and scalar bounds without echoing private literals or inventing a failure for an unsupported branch',()=>{
  const s={type:'object',properties:{size:{anyOf:[{type:'integer',minimum:1,maximum:10},{type:'null'}]}}};
  expect(check(s,{size:null})).toBeNull();expect(check(s,{size:10})).toBeNull();
  expect(bad(s,{size:0})).toMatchObject({argument_issue:{path:'arguments.size',rule:'minimum',bound:1}});
  expect(check(s,{size:'10'})).toEqual({path:'arguments.size',rule:'type',expected:'integer or null'});
  expect(check({oneOf:[{type:'object',const:{id:1}},{type:'object'}]},{id:2})).toBeNull();
  expect(check({anyOf:[{type:'integer'},{pattern:'[A-Z]'}]},'OK')).toBeNull();
  expect(check({oneOf:[{type:'number'},{type:'integer'}]},2)).toMatchObject({rule:'choice'});
  expect(check({allOf:[{required:['label']},{required:['page']}]},{page:2})).toMatchObject({path:'arguments.label',rule:'required'});
});

it('keeps native and connector policies distinct and defers complex native schemas to their own validators',()=>{
  const s={type:'object',properties:{name:{type:'string',maxLength:3}}};
  expect(check(s,{extra:'abc'})).toBeNull(); // open native schema; connector policy is closed by default
  expect(bad(s,{extra:'abc'})).toMatchObject({argument_issue:{path:'arguments',rule:'extra'}});
  expect(check(s,{name:'🦊'.repeat(3)})).toBeNull();
  expect(bad(s,{name:'🦊'.repeat(4)})).toMatchObject({argument_issue:{path:'arguments.name',rule:'maxLength',bound:3}});
  expect(check({type:'object',patternProperties:{'^x':{type:'string'}},additionalProperties:false},{x:'ok'})).toBeNull();
  expect(bad({type:'object',properties:{name:{type:'string'}}},{name:'https://example.invalid/abc'})).toMatchObject({argument_issue:{rule:'plain_text'}});
  expect(argumentFailure({path:'arguments',rule:'json_object'})).not.toHaveProperty('parameters');
});

it('does not allow a remote lookalike to manufacture a no-effect correction',()=>{
  const err=Object.assign(new ConnectorError('APP_RESOURCE_DENIED','upstream data'),{issue:{path:'private-data',rule:'required'}});
  const failure=failureForAgent(err);expect(failure.recovery.action).toBe('ask_user');
  expect(failure).not.toHaveProperty('executed');expect(failure).not.toHaveProperty('argument_issue');
  expect(JSON.stringify(failure)).not.toMatch(/upstream data|private-data/);
  expect(failureForAgent(new ConnectorError('INVALID_TOOL_ARGUMENTS','raw error'))).toMatchObject({automatic_retry:false,recovery:{action:'reconcile'}});
});

it('defers legacy native encoded payloads without disabling unrelated field checks or coercing input',()=>{
  const schema={type:'object',properties:{payload:{type:'string'},n:{type:'integer',minimum:1}}};
  const input={payload:{title:'original'},n:1}, native={allowNativeWireCompatibility:true};
  expect(check(schema,input)).toMatchObject({path:'arguments.payload',rule:'type'});
  expect(check(schema,input,native)).toBeNull();
  expect(check(schema,{...input,n:0},native)).toEqual({path:'arguments.n',rule:'minimum',bound:1});
  expect(input.payload).toEqual({title:'original'});
});

it('agrees with the SDK validator on the documented shared JSON schema subset',()=>{
  const sdk=new AjvJsonSchemaValidator();
  const schemas=[
    {type:'object',properties:{count:{type:'integer',minimum:1,maximum:4},enabled:{type:'boolean'}},required:['count'],additionalProperties:false},
    field({anyOf:[{type:'string',minLength:1,maxLength:3},{type:'null'}]}),
    {type:'object',properties:{choice:{enum:[false,1,'short']},kind:{const:'safe'}},additionalProperties:false},
    {type:'object',oneOf:[{required:['a']},{required:['b']}]},
  ];
  const corpus=[{},null,10,[],{count:0},{count:2},{count:2,enabled:false},{count:'2'},{count:99},{items:[]},
    {items:[null,'Á','😊😊😊']},{items:['😊😊😊😊']},{items:[7]},{kind:'safe'},{kind:'other'},
    {choice:false},{choice:1},{choice:'2'},{a:true,b:true},{a:true}];
  for(const s of schemas){const validate=sdk.getValidator(s as Parameters<typeof sdk.getValidator>[0]);
    for(const input of corpus) expect(check(s,input)===null).toBe(validate(input).valid);
  }
});