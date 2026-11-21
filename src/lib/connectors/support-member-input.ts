import { validateConnectorInput } from './schema-validation';
import { ConnectorError } from './types';

type Schema = Record<string, any>;
const unsupported = () => new ConnectorError('SCHEMA_UNSUPPORTED', 'This action has no supported member read range.', 409);

/** Support has an independent 1..5 cap. A provider can narrow that set, never expand it. */
export function supportMemberInput(reviewed: Schema, field: string | null) {
  if (!field) return { parameters: reviewed, readLimit: undefined };
  if (!Object.hasOwn(reviewed.properties, field)) throw unsupported();
  const check = {type:'object', properties:{count:reviewed.properties[field]}, required:['count']};
  const allowed = [1,2,3,4,5].filter(count => {
    try { validateConnectorInput(check, {count}); return true; }
    catch (error) {
      if (error instanceof ConnectorError && error.code==='INVALID_TOOL_ARGUMENTS') return false;
      throw error;
    }
  });
  if (!allowed.length) throw unsupported();
  const minimum=allowed[0], maximum=allowed[allowed.length-1];
  // Only 5 was authorized as an implicit default. Don't replace an omitted count by a different value.
  const preset=maximum===5 ? {default:5} : {};
  const countSchema={type:'integer',minimum,maximum,...(allowed.length!==maximum-minimum+1 && {enum:allowed}),...preset};
  const required=(reviewed.required ?? []).filter((k:string)=>k!==field);
  if (preset.default===undefined) required.push(field);
  return {parameters:{...reviewed,properties:{...reviewed.properties,[field]:countSchema},required},readLimit:{field,minimum,maximum,...preset}};
}