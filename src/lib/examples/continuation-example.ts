import { continueIncompleteJson, continuationClient } from '../services/continuation-client';
import { isIncompleteJson, attemptJsonRepair } from '../services/continuation-service';

/**
 * Ejemplo de uso del servicio de continuación de JSON
 * 
 * Este ejemplo muestra cómo utilizar el servicio de continuación de JSON
 * para completar una respuesta JSON incompleta de un agente de IA.
 */
export async function handleIncompleteJsonExample(incompleteJson: string): Promise<any> {
  console.log('Ejemplo de manejo de JSON incompleto');
  console.log('JSON incompleto recibido:', incompleteJson.substring(0, 100) + '...');
  
  // Paso 1: Verificar si el JSON está incompleto
  const isIncomplete = isIncompleteJson(incompleteJson);
  console.log('¿El JSON está incompleto?', isIncomplete);
  
  if (!isIncomplete) {
    console.log('El JSON ya es válido, no es necesario completarlo');
    return JSON.parse(incompleteJson);
  }
  
  // Paso 2: Intentar reparar el JSON sin usar IA (solución rápida)
  console.log('Intentando reparar el JSON sin usar IA...');
  const repairedJson = attemptJsonRepair(incompleteJson);
  
  if (repairedJson) {
    console.log('JSON reparado exitosamente sin usar IA');
    return repairedJson;
  }
  
  console.log('No se pudo reparar el JSON sin usar IA, intentando con el servicio de continuación...');
  
  // Paso 3: Usar el servicio de continuación para completar el JSON
  try {
    const result = await continueIncompleteJson(
      incompleteJson,
      'anthropic',
      'claude-3-opus-20240229',
      'https://example.com'
    );
    
    if (result.success && result.completeJson) {
      console.log('JSON completado exitosamente con el servicio de continuación');
      return result.completeJson;
    } else {
      console.error('Error al completar el JSON:', result.error);
      throw new Error(`Error al completar el JSON: ${result.error}`);
    }
  } catch (error: any) {
    console.error('Error en el servicio de continuación:', error);
    throw new Error(`Error en el servicio de continuación: ${error.message || 'Error desconocido'}`);
  }
}

/**
 * Ejemplo de uso del cliente de continuación
 * 
 * Este ejemplo muestra cómo utilizar el cliente de continuación
 * para completar una respuesta JSON incompleta de un agente de IA.
 */
export async function handleIncompleteJsonWithClient(
  incompleteJson: string,
  modelType: 'anthropic' | 'openai' | 'gemini' = 'anthropic',
  modelId: string = 'claude-3-opus-20240229'
): Promise<any> {
  console.log('Ejemplo de manejo de JSON incompleto con el cliente');
  
  // Usar el cliente de continuación directamente
  // Verificar si el JSON está incompleto
  if (!continuationClient.isIncomplete(incompleteJson)) {
    console.log('El JSON ya es válido, no es necesario completarlo');
    return JSON.parse(incompleteJson);
  }
  
  // Intentar reparar el JSON sin usar IA
  const repairedJson = continuationClient.attemptRepair(incompleteJson);
  if (repairedJson) {
    console.log('JSON reparado exitosamente sin usar IA');
    return repairedJson;
  }
  
  // Usar el cliente para completar el JSON
  const result = await continuationClient.continueGeneration({
    incompleteJson,
    modelType,
    modelId,
    siteUrl: 'https://example.com',
    includeScreenshot: false,
    timeout: 60000, // 60 segundos
    maxRetries: 2
  });
  
  if (result.success && result.completeJson) {
    console.log('JSON completado exitosamente con el cliente');
    return result.completeJson;
  } else {
    console.error('Error al completar el JSON con el cliente:', result.error);
    throw new Error(`Error al completar el JSON con el cliente: ${result.error}`);
  }
}

/**
 * Ejemplo de JSON incompleto para pruebas
 */
export const exampleIncompleteJson = `{
  "url": "https://example.com",
  "segmentsAnalyzed": 3,
  "segments": [
    {
      "name": "Digital Content Creators",
      "description": "Professionals and enthusiasts aged 20-40 dedicated to creating digital content",
      "summary": "Highly profitable segment of digital creators with specific needs",
      "targetAudience": "media_entertainment",
      "size": "189,000",
      "audienceProfile": {
        "adPlatforms": {
          "googleAds": {
            "demographics": {
              "ageRanges": ["25-34", "35-44"],
              "gender": ["male", "female"],
              "parentalStatus": ["parent"],
              "householdIncome": ["top 10%", "top 20%"]
            },
            "interests": [
              "Digital Content Creation",
              "Video Production",
              "Photography",
              "Graphic Design",
              "Technology Early Adopters"
            ],
            "inMarketSegments": [
              "Software",
              "Creative Software",
              "Video Editing Software",
              "Photography Equipment",
              "Computer Hardware"
            ],
            "locations": [
              "United States",
              "Canada",
              "United Kingdom",
              "Australia"
            ]
          }
        }
      },
      "language": "en"
    },
    {
      "name": "Small Business Owners",
      "description": "Entrepreneurs and small business owners looking for digital solutions",
      "summary": "Segment with high conversion potential and specific business needs",
      "targetAudience": "smb",
      "size": "250,000",
      "audienceProfile": {
        "adPlatforms": {
          "googleAds": {
            "demographics": {
              "ageRanges": ["35-44", "45-54"],
              "gender": ["male", "female"],
              "parentalStatus": ["parent"],
              "householdIncome": ["top 20%", "top 30%"]
            },
            "interests": [
              "Business Software",
              "Productivity Tools",
              "Small Business Solutions",
              "Digital Marketing",
              "E-commerce"
            ]
          }
        }
      },
      "language": "en"
    }
  ]
}`;

/**
 * Ejemplo de uso completo
 */
export async function runContinuationExample(): Promise<void> {
  console.log('Ejecutando ejemplo de continuación de JSON...');
  
  try {
    // Usar el ejemplo de JSON incompleto
    const result = await handleIncompleteJsonExample(exampleIncompleteJson);
    console.log('Resultado del ejemplo:', JSON.stringify(result, null, 2).substring(0, 200) + '...');
    
    // También probar con el cliente
    const clientResult = await handleIncompleteJsonWithClient(exampleIncompleteJson);
    console.log('Resultado con el cliente:', JSON.stringify(clientResult, null, 2).substring(0, 200) + '...');
    
    console.log('Ejemplo completado exitosamente');
  } catch (error: any) {
    console.error('Error en el ejemplo:', error);
  }
} 