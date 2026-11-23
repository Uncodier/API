import { directParameterPlan, snapshotDirectJson } from '../provider-direct-schema';
import { assertDirectArguments } from '../provider-direct-validation';
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
    {...valid,extra:true},{...valid,text:'\u0000'},{...valid,text:'x'.repeat(8001)}]) {
    expect(()=>assertDirectArguments(schema,args)).toThrow();
  }
});

it.each(['customAuthParams','account_id','connectedAccountId','userId','workspaceId','apiKey','api_key','access_token',
  'credential','projectRef','authConfigId','apikey','accessToken','ClientSecret','toJSON','constructor','__proto__'])('does not expose account/auth override %s or accept it despite the pinned provider schema', name=>{
  const props=Object.fromEntries([[name,{type:'string'}],['q',{type:'string'}]]);
  // Forbidden JSON keys are rejected by validateJson before schema compilation at the REST boundary.
  const plan=()=>directParameterPlan(object(props));
  if (['constructor','__proto__','toJSON'].includes(name)) { expect(()=>snapshotDirectJson(object(props))).toThrow(); return; }
  expect(Object.keys(plan().parameters.properties as object)).toEqual(['q']);
  expect(()=>assertDirectArguments(plan().parameters,Object.fromEntries([[name,'foreign']]))).toThrow();
  expect(()=>directParameterPlan(object(props,[name]))).toThrow();
});

it.each([
  ['sql','SELECT name FROM private_records'],['query','SELECT * FROM orders'],['code','print("example")'],
  ['command','echo example'],['inlineCode','return 1;'],['filePath','../local.txt'],['url','https://example.invalid/content'],
  ['filename','file:///local.txt'],['baseUrl','https://example.invalid'],['endpoint','/v1/orders'],
  ['callback','https://example.invalid/callback'],['script','<script>example</script>'],['requestHeaders','accept: application/json'],
  ['permissions','read'],['role','editor'],
])('preserves and validates provider capability field %s instead of vetoing its name or value', (name,value)=>{
  const plan=directParameterPlan(object({[name]:{type:'string'}},[name]));
  expect(Object.keys(plan.parameters.properties as object)).toEqual([name]);
  expect(()=>assertDirectArguments(plan.parameters,{[name]:value})).not.toThrow();
  expect(()=>assertDirectArguments(plan.parameters,{[name]:3})).toThrow();
  expect(()=>assertDirectArguments(plan.parameters,{[name]:value,unexpected:'extra'})).toThrow();
});

it.each([
  {type:'object',additionalProperties:true,properties:{}}, {type:'string',pattern:'^(a+)+$'}, {type:'number',multipleOf:3},
  {type:'object',properties:{props:{}}}, {type:'array'}, {type:'string',minLength:10001},
  {type:'string',enum:['A',{}]}, {anyOf:[{type:'null'}],const:'ignored'}, {$ref:'https://example.invalid/schema'},
  {$ref:'#/$defs/S',maxLength:1},
])('rejects unsupported/unsafe constraints rather than ignoring or evaluating them (%#)',value=>{
  expect(()=>directParameterPlan({...object({item:value}),$defs:{S:{type:'string'}}})).toThrow();
});

it('bounds cycles, expansions, alternate accounts/projects and unsupported vocabulary',()=>{
  const S={$ref:'#/$defs/S'};
  for(const raw of [{...object({input:S}),$defs:{S}},object({project_ref:{type:'string',default:'foreign'}}),
    object({user_id:{type:'string',default:'another'}}),object({api_key:{type:'string'}},['api_key']),
    object({mode:{type:'string',enum:['provider prompt with untrusted text']}})]) {
    expect(()=>directParameterPlan(raw)).toThrow();
  }
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
