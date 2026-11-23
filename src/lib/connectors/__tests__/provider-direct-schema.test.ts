import { directParameterPlan, snapshotDirectJson } from '../provider-direct-schema';
import { assertDirectArguments } from '../provider-direct-validation';
import { directActionNameSafe } from '../provider-direct-guards';
import { secret } from './composio-fixtures';

const object = (properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required});
const schema = directParameterPlan({ ...object({choices:{type:'array',items:{$ref:'#/$defs/Choice'},maxItems:4},
  label:{type:'string',enum:['draft','final']},count:{type:['integer','null'],minimum:0,maximum:10},text:{type:'string',minLength:2}},['choices','text']),
  $defs:{Choice:{anyOf:[{type:'null'},{type:'object',properties:{postal_code:{type:'string',pattern:'^[0-9]{4,5}$'}},required:['postal_code']}]}}}).parameters;
const valid={choices:[null,{postal_code:'46503'}],count:null,text:'paper draft',label:'draft'};

it('resolves bounded local definitions, honors nullable structured alternatives and closes every object',()=>{
  expect(()=>assertDirectArguments(schema,valid)).not.toThrow();
  expect(schema).toMatchObject({additionalProperties:false,properties:{choices:{maxItems:4,items:{anyOf:[{type:'null'},
    {type:'object',additionalProperties:false,properties:{postal_code:{pattern:'^[0-9]{4,5}$'}}}]}}}});
  for (const args of [{...valid,choices:[{postal_code:'111111'}]},{...valid,choices:[{postal_code:'1234',unexpected:1}]},
    {...valid,choices:new Array(5).fill(null)},{...valid,label:'else'},{...valid,text:'a'},{...valid,count:1.3},{...valid,count:11},
    {...valid,extra:true},{...valid,text:'../local.txt'},{...valid,text:'file:///local.txt'},{...valid,text:'data:text/plain;base64,zzz'},
    {...valid,text:'SELECT name FROM private_records'},{...valid,text:'https://example.invalid/content'},{...valid,text:'x'.repeat(8001)}]) {
    expect(()=>assertDirectArguments(schema,args)).toThrow();
  }
});

it.each(['customAuthParams','account_id','connectedAccountId','userId','workspaceId','baseURL','filePath','apiKey','api_key','access_token',
  'credential','headers','callback','script','projectRef','url','authConfigId','command','inlineCode','sql','code','apikey','requestHeaders','accessToken','filename','endpoint','baseUrl','ClientSecret','toJSON','constructor','__proto__'])('does not expose unsafe field %s or accept it despite the pinned provider schema', name=>{
  const props=Object.fromEntries([[name,{type:'string'}],['q',{type:'string'}]]);
  // Forbidden JSON keys are rejected by validateJson before schema compilation at the REST boundary.
  const plan=()=>directParameterPlan(object(props));
  if (['constructor','__proto__','toJSON'].includes(name)) { expect(()=>snapshotDirectJson(object(props))).toThrow(); return; }
  expect(Object.keys(plan().parameters.properties as object)).toEqual(['q']);
  expect(()=>assertDirectArguments(plan().parameters,Object.fromEntries([[name,'foreign']]))).toThrow();
  expect(()=>directParameterPlan(object(props,[name]))).toThrow();
});

it.each([
  {type:'object',additionalProperties:true,properties:{}}, {type:'string',pattern:'^(a+)+$'}, {type:'number',multipleOf:3},
  {type:'object',properties:{props:{}}}, {type:'array'}, {type:'string',minLength:10001},
  {type:'string',enum:['A',{}]}, {anyOf:[{type:'null'}],const:'ignored'}, {$ref:'https://example.invalid/schema'},
  {$ref:'#/$defs/S',maxLength:1}, {type:'string',default:'https://example.invalid/resource'},
])('rejects unsupported/unsafe constraints rather than ignoring or evaluating them (%#)',value=>{
  expect(()=>directParameterPlan({...object({item:value}),$defs:{S:{type:'string'}}})).toThrow();
});

it('bounds cycles, expansions, executable schema, alternate projects and defaults',()=>{
  const S={$ref:'#/$defs/S'};
  for(const raw of [{...object({input:S}),$defs:{S}},object({project_ref:{type:'string',default:'foreign'}}),
    object({user_id:{type:'string',default:'another'}}),object({base_url:{type:'string'}},['base_url']),
    object({extension:{type:'string',default:'<script>untrusted</script>'}}),object({mode:{type:'string',enum:['provider prompt with untrusted text']}})]) {
    expect(()=>directParameterPlan(raw)).toThrow();
  }
  expect(directActionNameSafe('drivecloud','DRIVECLOUD_CREATE_DELIVERABLE')).toBe(true);
  expect(directActionNameSafe('drivecloud','DRIVECLOUD_CREATE_DELIVERABLE\n')).toBe(false);
});

it('snapshots without executing serialization hooks, coercing sparse arrays, accepting cycles or trusting unknown issue paths',()=>{
  const marker=secret();const hook=jest.fn(()=>marker);
  const getter=Object.defineProperty({},'input',{get:hook,enumerable:true});
  const hidden=Object.defineProperty({},'toJSON',{value:hook});
  class CustomArray extends Array {toJSON=hook;}
  const circular: Record<string,unknown>={};circular.self=circular;
  for (const value of [[,1],{value:new CustomArray(1)},hidden,getter,{[Symbol('hidden')]:marker},circular]) {
    expect(()=>snapshotDirectJson(value)).toThrow();expect(hook).not.toHaveBeenCalled();
  }
  try {assertDirectArguments(schema,{...valid,[marker]:marker});throw new Error('not rejected');}
  catch(e) {expect(e).toMatchObject({code:'INVALID_TOOL_ARGUMENTS',issue:{rule:'extra',path:'arguments'}});expect(JSON.stringify(e)).not.toContain(marker);}
});
