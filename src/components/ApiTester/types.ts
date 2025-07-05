// Tipos comunes para el API Tester

// Tipo para los proveedores de modelos
export type ModelProviderType = 'anthropic' | 'openai' | 'gemini';

// Tipo para los campos adicionales
export interface AdditionalField {
  name: string;
  label: string;
  type: 'text' | 'checkbox' | 'select' | 'textarea' | 'number';
  options?: { value: string; label: string }[];
  defaultValue?: string | boolean | number;
  min?: number;
  max?: number;
  placeholder?: string;
  required?: boolean;
}

// Tipo para los tipos de API disponibles
export type ApiType = 
  | 'general' 
  | 'ai' 
  | 'site' 
  | 'segments' 
  | 'tester' 
  | 'icp' 
  | 'content' 
  | 'visitor_segment' 
  | 'send-email-from-agent' 
  | 'send-whatsapp'
  | 'customer-support'
  | 'email-analysis'
  | 'visitor_identify'
  | 'visitor_track'
  | 'visitor_session'
  | 'agents-apps'
  | 'customer-support-conversation-messages'
  | 'sales'
  | 'sales-venues'
  | 'intervention'
  | 'growth'
  | 'cmo-stakeholder-coordination'
  | 'customer-support-conversations'
  | 'requirements'
  | 'html-personalization'
  | 'basic-analyze'
  | 'copywriter'
  | 'chat'
  | 'create-task'
  | 'get-task'
  | 'update-task'
  | 'data-analyst-analysis'
  | 'data-analyst-lead-segmentation'
  | 'cmo-daily-standup-system';

// Interfaz base para todos los tipos de API
export interface BaseApiConfig {
  id: ApiType;
  name: string;
  description: string;
  defaultEndpoint: string;
  renderFields: (props: any) => JSX.Element;
  buildRequestBody: (state: any) => Record<string, any>;
  buildRequestHeaders?: (state: any) => Record<string, string>;
  buildRequestUrl?: (state: any, endpoint: string) => string;
  getInitialState: (props: any) => Record<string, any>;
}

// Props comunes para todos los tipos de API
export interface CommonApiProps {
  title?: string;
  description?: string;
  showJsonOption?: boolean;
  showScreenshotOption?: boolean;
  additionalFields?: AdditionalField[];
}

// Modelos disponibles por proveedor
export const MODEL_OPTIONS: Record<ModelProviderType, Array<{value: string, label: string}>> = {
  anthropic: [
    { value: 'claude-3-5-sonnet-20240620', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
    { value: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet' },
    { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
    { value: 'claude-2.1', label: 'Claude 2.1' },
    { value: 'claude-2.0', label: 'Claude 2.0' },
    { value: 'claude-instant-1.2', label: 'Claude Instant 1.2' }
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-4', label: 'GPT-4' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
  ],
  gemini: [
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    { value: 'gemini-1.0-pro', label: 'Gemini 1.0 Pro' },
    { value: 'gemini-1.0-ultra', label: 'Gemini 1.0 Ultra' }
  ]
};

// Ejemplos de código para diferentes tecnologías
export const codeExamples = {
  curl: (requestBody: any, method: string, apiUrl: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => {
    // Construir las cabeceras para cURL
    const headerString = Object.entries(headers)
      .map(([key, value]) => `-H "${key}: ${value}"`)
      .join(' \\\n  ');
    
    return `# Ejemplo con cURL
curl -X ${method} "${apiUrl}" \\
  ${headerString} \\
  -d '${JSON.stringify(requestBody, null, 2)}'`;
  },
  
  javascript: (requestBody: any, method: string, apiUrl: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => {
    // Construir las cabeceras para JavaScript
    const headersObj = JSON.stringify(headers, null, 2);
    
    return `// Ejemplo con JavaScript (Fetch API)
fetch("${apiUrl}", {
  method: "${method}",
  headers: ${headersObj},
  body: JSON.stringify(${JSON.stringify(requestBody, null, 2)})
})
.then(response => {
  if (!response.ok) throw new Error(\`Error HTTP: \${response.status}\`);
  return response.json();
})
.then(data => console.log("Respuesta:", data))
.catch(error => console.error("Error:", error));`;
  },
  
  python: (requestBody: any, method: string, apiUrl: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => {
    // Construir las cabeceras para Python
    const headersObj = JSON.stringify(headers, null, 4);
    
    return `# Ejemplo con Python (requiere: pip install requests)
import requests

headers = ${headersObj}

data = ${JSON.stringify(requestBody, null, 4)}

try:
    response = requests.${method.toLowerCase()}(
        "${apiUrl}",
        headers=headers,
        json=data
    )
    response.raise_for_status()
    result = response.json()
    print("Respuesta:", result)
except requests.exceptions.RequestException as e:
    print(f"Error: {e}")`;
  },
  
  php: (requestBody: any, method: string, apiUrl: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => {
    // Construir las cabeceras para PHP
    const headerString = Object.entries(headers)
      .map(([key, value]) => `        "${key}: " . ${key === 'Content-Type' ? `"${value}"` : `$${key.replace(/-/g, '_')}`}`)
      .join(',\n');
    
    // Construir las variables para PHP
    const variables = Object.entries(headers)
      .filter(([key]) => key !== 'Content-Type')
      .map(([key]) => `$${key.replace(/-/g, '_')} = "${headers[key]}";`)
      .join('\n');
    
    return `<?php
// Ejemplo con PHP (requiere extensión cURL)
${variables}
$url = "${apiUrl}";
$data = ${JSON.stringify(requestBody, null, 2)};

$curl = curl_init();
curl_setopt_array($curl, [
    CURLOPT_URL => $url,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST => "${method}",
    CURLOPT_POSTFIELDS => json_encode($data),
    CURLOPT_HTTPHEADER => [
${headerString}
    ],
]);

$response = curl_exec($curl);
$err = curl_error($curl);
curl_close($curl);

if ($err) {
    echo "Error: " . $err;
} else {
    $responseData = json_decode($response, true);
    echo "Respuesta: ";
    print_r($responseData);
}
?>`;
  }
};

// Interfaz para el estado del formulario
export interface ApiFormState {
  // Campos comunes
  endpoint: string;
  method: 'GET' | 'POST';
  url: string;
  includeScreenshot: boolean;
  jsonResponse: boolean;
  
  // Campos específicos por tipo de API
  message: string;
  conversationId: string;
  context: string;
  query: string;
  model: string;
  modelType: string;
  showModelOptions: boolean;
  analysisType: 'complete' | 'structure';
  timeout: string;
  depth: string;
  segmentCount: number;
  
  // Para campos adicionales dinámicos
  [key: string]: string | number | boolean | undefined;
}

import { Control, UseFormRegister, FieldErrors, FieldValues } from 'react-hook-form';
import { z } from 'zod';

export interface ApiEndpoint<T extends FieldValues> {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  schema: z.ZodType<T>;
  defaultValues: T;
  renderForm: (props: {
    register: UseFormRegister<T>;
    control: Control<T>;
    errors: FieldErrors<T>;
  }) => React.ReactNode;
} 