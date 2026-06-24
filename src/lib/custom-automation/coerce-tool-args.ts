/**
 * Parses nested stringified JSON that models like Gemini occasionally emit
 * instead of generating a proper nested object or array.
 * 
 * It handles double-stringification and recurses into nested schemas
 * (e.g., an array of objects that themselves contain stringified objects).
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

    let currentValue = value;

    // Handle stringified values first
    if ((propSchema.type === 'array' || propSchema.type === 'object') && typeof currentValue === 'string') {
      try {
        let parsed = JSON.parse(currentValue);
        // Handle double-stringify (sometimes Gemini returns '"[{\\"foo\\":\\"bar\\"}]"')
        if (typeof parsed === 'string') {
           parsed = JSON.parse(parsed);
        }
        
        if (propSchema.type === 'array' && Array.isArray(parsed)) {
          currentValue = parsed;
        } else if (propSchema.type === 'object' && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          currentValue = parsed;
        }
      } catch (err) {
        // Leave as string if parsing fails entirely
      }
    }

    // Now recurse if we successfully parsed (or it was already) an object/array
    if (propSchema.type === 'array' && Array.isArray(currentValue) && propSchema.items?.type === 'object') {
      currentValue = currentValue.map((item: any) => 
        (typeof item === 'object' && item !== null) ? coerceToolArgs(propSchema.items, item) : item
      );
    } else if (propSchema.type === 'object' && typeof currentValue === 'object' && currentValue !== null && !Array.isArray(currentValue)) {
      currentValue = coerceToolArgs(propSchema, currentValue);
    }

    coerced[key] = currentValue;
  }

  return coerced;
}
