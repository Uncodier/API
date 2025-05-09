// Re-exportar las funciones de utils.ts y utils.tsx
export { generateUUID } from '../utils';

// Importaciones temporales - estas funciones en realidad deberían venir de utils.tsx
export const formatJsonWithSyntax = (json: any) => {
  try {
    // Asegurarse de que el JSON esté bien formateado
    const jsonString = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
    return jsonString;
  } catch (error) {
    console.error('Error formatting JSON:', error);
    return typeof json === 'string' ? json : JSON.stringify(json, null, 2);
  }
};

export const highlightCode = (code: string, language: string) => {
  return code;
}; 