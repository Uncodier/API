import type { CustomerSupportToolDefinition } from "../customer-support-tool-catalog";

type VoiceToolContract = Pick<CustomerSupportToolDefinition, "name" | "parameters">;
type Schema = Record<string, unknown>;
type ArgumentIssue = { field: string; requirement: string };

function record(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Schema
    : undefined;
}

function requiredFields(schema: Schema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((field): field is string => typeof field === "string")
    : [];
}

function allowedValues(schema: Schema): string {
  return (schema.enum as unknown[]).map((value) => JSON.stringify(value)).join(", ");
}

function parameterDescription(schema: Schema, includeType = false): string {
  const parts: string[] = [];
  if (includeType && typeof schema.type === "string") parts.push(`Type: ${schema.type}.`);
  if (schema.type === "integer") parts.push("Must be an integer.");
  if (Array.isArray(schema.enum)) parts.push(`Allowed values: ${allowedValues(schema)}.`);
  if (typeof schema.minimum === "number") parts.push(`Minimum: ${schema.minimum}.`);
  if (typeof schema.maximum === "number") parts.push(`Maximum: ${schema.maximum}.`);
  if (schema.format === "date-time") parts.push("ISO 8601 date-time with timezone required.");
  const required = requiredFields(schema);
  if (required.length) parts.push(`Required fields: ${required.join(", ")}.`);
  if (schema.additionalProperties === false) parts.push("Only declared fields are allowed.");
  if (typeof schema.description === "string") parts.push(schema.description);
  const properties = record(schema.properties);
  if (properties) {
    parts.push(`Fields: ${Object.entries(properties).map(([name, child]) =>
      `${name} (${parameterDescription(record(child) || {}, true)})`
    ).join("; ")}.`);
  }
  const items = record(schema.items);
  if (items) parts.push(`Each array item: ${parameterDescription(items, true)}`);
  return parts.join(" ");
}

/**
 * Zavu keeps only type/description on properties. Put the known catalog's
 * constraints (including nested objects/items) in that surviving description.
 * This is a provider projection, not a replacement for the local source schema.
 */
export function projectVoiceToolParameters(tool: VoiceToolContract): Schema {
  const properties = record(tool.parameters.properties) || {};
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(properties).map(([name, value]) => {
      const schema = record(value) || {};
      let description = parameterDescription(schema);
      if (tool.name === "QUALIFY_LEAD" && ["lead_id", "email", "phone"].includes(name)) {
        description = `Provide at least one of lead_id, email, phone. ${description}`;
      }
      return [name, {
        // The provider's number type also carries integer inputs.
        type: schema.type === "integer" ? "number" : schema.type,
        description,
      }];
    })),
    required: [...requiredFields(tool.parameters)],
  };
}

/** Only schema-derived paths/requirements belong here, never supplied values. */
export class VoiceToolArgumentValidationError extends Error {
  readonly code = "VOICE_TOOL_INVALID_ARGUMENTS";
  readonly fields: string[];

  constructor(issues: readonly ArgumentIssue[]) {
    super(`Invalid Voice tool arguments. ${issues.map(({ field, requirement }) =>
      `${field}: ${requirement}`
    ).join(" ")} Correct only invalid_fields; keep other confirmed inputs and do not retry unchanged arguments.`);
    this.name = "VoiceToolArgumentValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.fields = Array.from(new Set(issues.map(({ field }) => field)));
  }
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "object": return Boolean(record(value));
    case "array": return Array.isArray(value);
    default: return true;
  }
}

/**
 * Validate the subset used by the voice catalog, not arbitrary JSON Schema.
 * Action-specific business checks remain in the existing native executors.
 * Call after trusted scoping, before execution/command_id injection.
 */
export function validateVoiceToolArguments(tool: VoiceToolContract, args: Schema): void {
  const issues: ArgumentIssue[] = [];
  const add = (path: string, requirement: string) => {
    const field = path || "arguments";
    if (!issues.some((issue) => issue.field === field && issue.requirement === requirement)) {
      issues.push({ field, requirement });
    }
  };
  const childPath = (path: string, name: string) => path ? `${path}.${name}` : name;

  function visit(schema: Schema, value: unknown, path: string): void {
    // These two catalog fields document null=unlimited and their native
    // handlers support it, despite the shared schema's number-only type.
    if (tool.name === "catalog_commerce" && value === null && ["max_select", "pass_uses"].includes(path)) return;
    if (!matchesType(value, schema.type)) {
      add(path, `must be ${schema.type}.`);
      return;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      add(path, `allowed values are ${allowedValues(schema)}.`);
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) add(path, `minimum is ${schema.minimum}.`);
      if (typeof schema.maximum === "number" && value > schema.maximum) add(path, `maximum is ${schema.maximum}.`);
    }
    if (typeof value === "string" && schema.format === "date-time" && (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      || !Number.isFinite(Date.parse(value))
    )) {
      add(path, "use an ISO 8601 date-time with timezone.");
    }
    const object = record(value);
    if (object) {
      const properties = record(schema.properties) || {};
      for (const name of requiredFields(schema)) {
        if (object[name] === undefined) add(childPath(path, name), "required.");
      }
      for (const [name, child] of Object.entries(properties)) {
        const childSchema = record(child);
        if (object[name] !== undefined && childSchema) visit(childSchema, object[name], childPath(path, name));
      }
      if (schema.additionalProperties === false && Object.keys(object).some((name) =>
        !Object.prototype.hasOwnProperty.call(properties, name)
      )) {
        // User-supplied keys can contain secrets too. Name only the source parent.
        add(path, "only declared fields are allowed; remove undeclared fields.");
      }
    }
    const items = record(schema.items);
    if (Array.isArray(value) && items) {
      for (const item of value) visit(items, item, `${path}[]`);
    }
  }

  visit(tool.parameters, args, "");
  // QUALIFY_LEAD's oneOf means alternative identifiers in its documented API,
  // not exclusivity: trusted scoping can supply both caller phone and lead_id.
  if (tool.name === "QUALIFY_LEAD" && !["lead_id", "email", "phone"].some((name) =>
    typeof args[name] === "string" && args[name].trim()
  )) {
    for (const field of ["lead_id", "email", "phone"]) {
      add(field, "provide at least one of lead_id, email, phone.");
    }
  }
  if (issues.length) throw new VoiceToolArgumentValidationError(issues);
}