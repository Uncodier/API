/**
 * Parses nested stringified JSON that models like Gemini occasionally emit
 * instead of generating a proper nested object or array.
 * 
 * E.g., `args` may contain:
 * `{ action: "create", steps: "[{\"title\":\"Foo\"}]" }`
 * instead of
 * `{ action: "create", steps: [{title:"Foo"}] }`
 */

export function coerceToolArgs(schema: any, args: any): any {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return args;
  }

  if (!schema || schema.type !== 'object' || !schema.properties) {
    return args;
  }

  const coerced = { ...args };

  for (const [key, value] of Object.entries(coerced)) {
    const propSchema = schema.properties[key];
    if (!propSchema) continue;

    // If the schema expects an object or array, but the value is a string,
    // we attempt to parse it.
    if ((propSchema.type === 'array' || propSchema.type === 'object') && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        // Only accept the parse if it matches the expected top-level type
        if (propSchema.type === 'array' && Array.isArray(parsed)) {
          coerced[key] = parsed;
        } else if (propSchema.type === 'object' && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          coerced[key] = parsed;
        }
      } catch (err) {
        // If it fails to parse, leave it as a string. Zod will reject it later with a clearer error.
      }
    }
  }

  return coerced;
}
