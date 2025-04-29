'use client';

import React, { useState } from 'react';
import { UnifiedApiTester } from './ApiTester/UnifiedApiTester';

// Re-export UnifiedApiTester
export { UnifiedApiTester };

// Interfaz para las props del ApiTester
export interface ApiTesterProps {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  endpoint: string;
  description?: string;
  requestFormat?: Record<string, any>;
  defaultBody?: Record<string, any>;
}

// Componente ApiTester reutilizable para documentación
export const ApiTester: React.FC<ApiTesterProps> = ({ 
  method, 
  endpoint, 
  description = '', 
  requestFormat = {}, 
  defaultBody = {} 
}) => {
  const [formState, setFormState] = useState<Record<string, any>>(defaultBody);
  const [response, setResponse] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'request' | 'response' | 'code'>('request');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    try {
      const requestOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json'
        }
      };
      
      // Añadir body solo para métodos POST, PUT, DELETE
      if (method !== 'GET') {
        requestOptions.body = JSON.stringify(formState);
      }
      
      // Construir URL con query params para GET
      let url = endpoint;
      if (method === 'GET' && Object.keys(formState).length > 0) {
        const queryParams = new URLSearchParams();
        Object.entries(formState).forEach(([key, value]) => {
          if (value !== null && value !== undefined && value !== '') {
            queryParams.append(key, String(value));
          }
        });
        url = `${endpoint}?${queryParams.toString()}`;
      }
      
      const res = await fetch(url, requestOptions);
      const data = await res.json();
      
      setResponse(data);
      setActiveTab('response');
    } catch (err: any) {
      setError(err.message || 'Error al realizar la petición');
    } finally {
      setLoading(false);
    }
  };
  
  const handleInputChange = (field: string, value: any) => {
    setFormState((prev) => ({
      ...prev,
      [field]: value
    }));
  };
  
  const renderRequestForm = () => {
    return (
      <form onSubmit={handleSubmit} className="space-y-4">
        {Object.entries(requestFormat).map(([field, description]) => {
          // Determinar si es requerido y otros metadatos
          const isRequired = String(description).includes('[required]');
          const isObject = typeof description === 'object';
          
          if (isObject) {
            // Manejar objetos anidados
            return (
              <div key={field} className="border p-4 rounded-md">
                <h4 className="font-medium mb-2">{field}</h4>
                {Object.entries(description as Record<string, any>).map(([subField, subDesc]) => (
                  <div key={`${field}.${subField}`} className="mb-2">
                    <label className="block text-sm font-medium mb-1">
                      {subField} {String(subDesc).includes('[required]') && <span className="text-red-500">*</span>}
                    </label>
                    <input
                      type="text"
                      value={formState[field]?.[subField] || ''}
                      onChange={(e) => {
                        const newValue = {...(formState[field] || {})};
                        newValue[subField] = e.target.value;
                        handleInputChange(field, newValue);
                      }}
                      className="w-full p-2 border rounded-md"
                      placeholder={String(subDesc).replace(/\[.*?\]/g, '').trim()}
                    />
                  </div>
                ))}
              </div>
            );
          }
          
          // Campos básicos
          return (
            <div key={field} className="mb-2">
              <label className="block text-sm font-medium mb-1">
                {field} {isRequired && <span className="text-red-500">*</span>}
              </label>
              <input
                type="text"
                value={formState[field] || ''}
                onChange={(e) => handleInputChange(field, e.target.value)}
                className="w-full p-2 border rounded-md"
                placeholder={String(description).replace(/\[.*?\]/g, '').trim()}
                required={isRequired}
              />
            </div>
          );
        })}
        
        <button
          type="submit"
          className="bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600"
          disabled={loading}
        >
          {loading ? 'Enviando...' : 'Enviar solicitud'}
        </button>
      </form>
    );
  };
  
  const renderResponse = () => {
    if (error) {
      return (
        <div className="bg-red-50 border border-red-200 p-4 rounded-md">
          <h4 className="text-red-700 font-medium">Error</h4>
          <p className="text-red-600">{error}</p>
        </div>
      );
    }
    
    if (!response) {
      return (
        <div className="bg-gray-50 border p-4 rounded-md">
          <p className="text-gray-600">No hay respuesta disponible. Envía una solicitud primero.</p>
        </div>
      );
    }
    
    return (
      <div className="bg-gray-50 border p-4 rounded-md overflow-auto">
        <pre className="text-sm whitespace-pre-wrap break-all">
          {JSON.stringify(response, null, 2)}
        </pre>
      </div>
    );
  };
  
  const renderCodeExample = () => {
    const bodyParam = method !== 'GET' && Object.keys(defaultBody).length > 0
      ? `\n  body: JSON.stringify(${JSON.stringify(defaultBody, null, 2)}),`
      : '';
      
    return (
      <div className="bg-gray-50 border p-4 rounded-md overflow-auto">
        <div className="mb-4">
          <h4 className="font-medium mb-2">JavaScript / TypeScript</h4>
          <pre className="text-sm bg-gray-800 text-white p-4 rounded-md overflow-auto">
            {`// Ejemplo de uso con fetch
const response = await fetch('${endpoint}', {
  method: '${method}',
  headers: {
    'Content-Type': 'application/json',
  },${bodyParam}
});

const data = await response.json();
console.log(data);`}
          </pre>
        </div>
        
        <div className="mb-4">
          <h4 className="font-medium mb-2">Python</h4>
          <pre className="text-sm bg-gray-800 text-white p-4 rounded-md overflow-auto">
            {`# Ejemplo de uso con requests
import requests
import json

headers = {
    'Content-Type': 'application/json',
}
${method !== 'GET' && Object.keys(defaultBody).length > 0 
  ? `\ndata = json.dumps(${JSON.stringify(defaultBody, null, 2).replace(/"/g, "'")})

response = requests.${method.toLowerCase()}('${endpoint}', headers=headers, data=data)`
  : `\nresponse = requests.${method.toLowerCase()}('${endpoint}', headers=headers)`}

print(response.json())`}
          </pre>
        </div>
      </div>
    );
  };
  
  return (
    <div className="border rounded-md overflow-hidden">
      {description && (
        <div className="p-4 border-b bg-gray-50">
          <p>{description}</p>
        </div>
      )}
      
      <div className="flex border-b">
        <button
          className={`px-4 py-2 ${activeTab === 'request' ? 'bg-blue-50 border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('request')}
        >
          Solicitud
        </button>
        <button
          className={`px-4 py-2 ${activeTab === 'response' ? 'bg-blue-50 border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('response')}
        >
          Respuesta
        </button>
        <button
          className={`px-4 py-2 ${activeTab === 'code' ? 'bg-blue-50 border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('code')}
        >
          Código
        </button>
      </div>
      
      <div className="p-4">
        {activeTab === 'request' && renderRequestForm()}
        {activeTab === 'response' && renderResponse()}
        {activeTab === 'code' && renderCodeExample()}
      </div>
    </div>
  );
};

const DefaultApiTester: React.FC = () => {
  const [site_id, setSiteId] = useState<string>('');
  const [event_type, setEventType] = useState<string>('');
  const [event_name, setEventName] = useState<string>('');
  const [url, setUrl] = useState<string>('');
  const [referrer, setReferrer] = useState<string>('');
  const [visitor_id, setVisitorId] = useState<string>('');
  const [session_id, setSessionId] = useState<string>('');
  const [properties, setProperties] = useState<string>('{}');
  const [response, setResponse] = useState<any>(null);
  const [endpoint, setEndpoint] = useState<string>('/api/visitors/track');
  const [method, setMethod] = useState<string>('POST');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const data = {
      site_id,
      event_type,
      event_name,
      url,
      referrer,
      visitor_id,
      session_id,
      timestamp: Date.now(),
      properties: JSON.parse(properties)
    };

    try {
      const response = await fetch(endpoint, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-SA-API-KEY': 'your-api-key' // Replace with actual API key
        },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      setResponse(result);
    } catch (error) {
      console.error('Error:', error);
      setResponse({ error: 'Failed to send request' });
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* ... existing form fields ... */}
      <div>
        <label>Properties (JSON):</label>
        <textarea
          value={properties}
          onChange={(e) => setProperties(e.target.value)}
          placeholder='{"events": [], "activity": []}'
        />
      </div>
      <button type="submit">Send Request</button>
      {response && <pre>{JSON.stringify(response, null, 2)}</pre>}
    </form>
  );
};

export default DefaultApiTester; 