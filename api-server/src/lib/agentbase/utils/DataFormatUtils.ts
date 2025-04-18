/**
 * Utilidades para el procesamiento y formato de datos
 */

/**
 * Extrae el ID de conversación del contexto
 */
export function extractConversationId(context: string): string | null {
  if (!context) return null;
  
  // First try the "Conversation ID: UUID" format
  let match = context.match(/Conversation ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (match) return match[1];
  
  // Then try just "conversationId: UUID" format
  match = context.match(/conversationId:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (match) return match[1];
  
  // Try to find any UUID in the context
  match = context.match(/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  return match ? match[1] : null;
}

/**
 * Asegura que exista la propiedad 'targets' en un array
 */
export function ensureTargetContentExists(targets: any[]): any[] {
  // Si targets no existe o no es un array, devolver array vacío
  if (!targets || !Array.isArray(targets)) return [];
  
  // Simplemente devolver el array de targets sin modificar su estructura
  return targets;
} 