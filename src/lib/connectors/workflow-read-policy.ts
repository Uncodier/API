import { z } from 'zod';
import { safeText, scopesSchema, toolkitSlug, toolSlug } from './composio-validation';
import { directEffect, directFieldSafe } from './provider-direct-guards';
import { directParameterPlan } from './provider-direct-schema';
import { validateConnectorArguments } from './composio-tool-json';
import { assertDirectArguments } from './provider-direct-validation';
import { MAX_WORKFLOW_ITEMS, workflowOutputContract } from './workflow-read-output';
import { denied, release } from './workflow-read-binding';

type Dict = Record<string,unknown>;
const object = (v:unknown): v is Dict => !!v && typeof v==='object' && !Array.isArray(v);
export const metadata = z.object({slug:toolSlug,toolkit:z.object({slug:toolkitSlug}),version:release,
  description:safeText(16_000), input_parameters:z.record(z.unknown()), output_parameters:z.record(z.unknown()).nullish(),
  no_auth:z.literal(false), is_deprecated:z.literal(false), deprecated:z.object({is_deprecated:z.literal(false).optional()}).nullish(),
  scopes:scopesSchema,scope_requirements:z.null(),tags:z.array(safeText(100)).min(1).max(64)});
const words = (s:string) => s.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[^a-z0-9]+/gi,' ').toLowerCase();
// Denials only. Neither a name nor a schema is positive evidence of an allowed effect.
const dangerous = /\b(?:admin\w*|proxy|proxies|sql|graphql|queries|database|terminal|pipeline|automation|workflows?|deploy\w*|terraform|arbitrary|jsonrpc|rpc|python|javascript|powershell|bash|curl|provision\w*|eval\w*|exec\w*|scripts?|codes?|shell|commands?|http|requests?|endpoints?|methods?|headers?|urls?|uris?|paths?|files?|webhooks?|tokens?|secrets?|credentials?|permissions?|roles?|grants?|bulk|batch|exports?|imports?|downloads?|uploads?|creat\w*|updat\w*|delet\w*|mutat\w*|writ\w*|send\w*|destruct\w*|publish\w*|triggers?|invoke\w*|run|destroy\w*|revoke\w*|clone\w*|assign\w*|purchase\w*|charge\w*|redeem\w*|start|stop|restart|launch|bulk|payload|custom|impersonat\w*|unbounded)\b/i;
const pageSize = /^(?:limit|page size|per page|max results|max records)$/;
// Scope identifiers are provider-owned, not a universal action taxonomy. Use exact
// membership and veto expressly dangerous grants, not a provider-specific read dictionary.
const unsafeScope = /\b(?:admin\w*|impersonat\w*|manage\w*|write|modify|create|delete|update|send|execute|full|sudo)\b/;
export function checkScopes(required:string[], actual:string[], keyAuth:boolean) {
  if ((!keyAuth && !required.length) || required.some(s=>s.includes('*') || unsafeScope.test(words(s))) ||
      !Array.isArray(actual) || !required.every(s => actual.includes(s)) || actual.some(s => s!=='oauth' && !required.includes(s))) denied();
}
function inspect(schema:unknown, depth=0) {
  if (!object(schema) || depth>10) denied();
  for (const k of ['title','description','human_parameter_description']) {
    if (typeof schema[k]==='string' && dangerous.test(words(schema[k]))) denied();
  }
  // No hidden provider defaults, references, injected targets or open maps. Review exactly the shape that will execute.
  if (schema.$ref || schema.$defs || schema.definitions) denied();
  if (object(schema.properties)) for (const [k,v] of Object.entries(schema.properties)) {
    if (['all','fetch all','return all','unlimited','paginate','auto paginate','follow next','expand all','bulk'].includes(words(k))) denied();
    if (!directFieldSafe(k) || dangerous.test(words(k)) || ['version','text','site id','host'].includes(words(k))) denied();
    if (k==='query' && (!object(v) || v.type!=='string' || v.default!=null)) denied();
    if (object(v) && v.default!=null && !pageSize.test(words(k)) && v.default!==false && !(Array.isArray(v.default) && !v.default.length)) denied();
    inspect(v,depth+1);
  }
  if (schema.items !== undefined) inspect(schema.items,depth+1);
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach(v=>inspect(v,depth+1));
}
export function readContract(tool:z.infer<typeof metadata>) {
  const kit=tool.toolkit.slug;
  if (!tool.tags.includes('readOnlyHint') || directEffect(tool.tags,kit,tool.slug)!=='read' ||
      dangerous.test(words([kit,tool.slug,tool.description,...tool.tags].join(' ')))) denied();
  if (/\b(?:sql|graphql|database|code|raw|custom) query\b|\bquery (?:language|statement|script|endpoint)\b/i.test(words(tool.slug+' '+tool.description))) denied();
  inspect(tool.input_parameters);
  const {parameters,injected}=directParameterPlan(tool.input_parameters);
  if (Object.keys(injected).length || !object(parameters.properties)) denied();
  const sizes=Object.keys(parameters.properties).filter(k=>pageSize.test(words(k)));
  if (sizes.length>1) denied();
  if (sizes.length) {
    const field=sizes[0], spec=parameters.properties[field];
    if (!object(spec) || spec.type!=='integer') denied();
    spec.minimum=Math.max(Number(spec.minimum??1),1); spec.maximum=Math.min(Number(spec.maximum??MAX_WORKFLOW_ITEMS),MAX_WORKFLOW_ITEMS);
    if (Number(spec.maximum)<Number(spec.minimum)) denied();
    parameters.required=[...new Set([...(parameters.required as string[]??[]),field])];
  }
  return {input_schema:parameters, outputContract:workflowOutputContract(tool.output_parameters,sizes[0])};
}
export function checkWorkflowArguments(parameters:Dict,args:unknown) {
  validateConnectorArguments(args);
  assertDirectArguments(parameters,args);
  // Search literals only. Never forward query DSLs, SQL fragments, or interpolation.
  const visit=(v:unknown):void=>{if (Array.isArray(v)) v.forEach(visit); else if (object(v)) for (const [k,item] of Object.entries(v)) {
    if (k==='query' && (typeof item!=='string' || !/^[\p{L}\p{N} -]{1,128}$/u.test(item) || /\b(?:select|insert|update|delete|drop|alter|from|union|exec|grant|revoke)\b/i.test(item))) denied();
    visit(item);
  }};
  visit(args);
}
