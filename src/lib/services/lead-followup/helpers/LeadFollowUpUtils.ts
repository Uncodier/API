// Helper to safely stringify JSON without crashing on circular references or large objects
export function safeJsonStringify(obj: any, maxLength: number = 500): string {
  try {
    const str = JSON.stringify(obj, null, 2);
    return str.length > maxLength ? str.substring(0, maxLength) + '... [truncated]' : str;
  } catch (error: any) {
    return `[JSON serialization error: ${error.message}]`;
  }
}

// Helper to parse both JSON and multipart/form-data requests
export async function parseIncomingRequest(request: Request, requestId?: string): Promise<{ body: any, files: Record<string, any> }> {
  const contentType = request.headers.get('content-type') || '';
  const files: Record<string, any> = {};
  let body: any = {};
  try {
    console.log(`[LeadFollowUp:${requestId || 'no-trace'}] CP0 content-type: ${contentType}`);
    if (contentType.includes('application/json')) {
      body = await request.json();
    } else if (contentType.includes('multipart/form-data')) {
      const formData = await (request as any).formData();
      for (const [key, value] of (formData as any).entries()) {
        if (typeof File !== 'undefined' && value instanceof File) {
          files[key] = value as any;
        } else {
          body[key] = value;
        }
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await (request as any).formData();
      for (const [key, value] of (formData as any).entries()) {
        body[key] = value;
      }
    } else {
      // Try JSON as a fallback
      try {
        body = await request.json();
      } catch {
        // No-op, leave body as empty
      }
    }
    console.log(`[LeadFollowUp:${requestId || 'no-trace'}] CP1 parsed keys:`, Object.keys(body));
    console.log(`[LeadFollowUp:${requestId || 'no-trace'}] CP1 files present:`, Object.keys(files));
  } catch (e) {
    console.error('Error parsing incoming request body:', e);
  }
  return { body, files };
}

// Function to validate UUIDs
export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Function to validate phone numbers
export function isValidPhoneNumber(phoneNumber: string): boolean {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return false;
  }
  
  // Remove all whitespace and check if empty
  const cleanPhone = phoneNumber.trim();
  if (cleanPhone === '') {
    return false;
  }
  
  // Basic validation: must contain at least some digits and be at least 7 characters
  // This catches empty strings, whitespace-only strings, and very short inputs
  const digitCount = (cleanPhone.match(/\d/g) || []).length;
  const hasMinLength = cleanPhone.length >= 7;
  const hasMinDigits = digitCount >= 7;
  
  return hasMinLength && hasMinDigits;
}
