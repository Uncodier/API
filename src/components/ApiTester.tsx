'use client';

import React, { useState } from 'react';
import styles from './ApiTester.module.css';

// Interfaz para las props del ApiTester
export interface ApiTesterProps {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  endpoint: string;
  description?: string;
  requestFormat?: Record<string, any>;
  defaultParams?: Record<string, any>;
  defaultBody?: Record<string, any>;
}

// Componente ApiTester reutilizable para documentación
export const ApiTester: React.FC<ApiTesterProps> = ({ 
  method, 
  endpoint, 
  description = '', 
  requestFormat = {}, 
  defaultParams = {},
  defaultBody = {} 
}) => {
  const [formState, setFormState] = useState<Record<string, any>>({...defaultParams, ...defaultBody});
  const [apiKey, setApiKey] = useState<string>('');
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
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        }
      };
      
      // Añadir body solo para métodos POST, PUT, DELETE
      if (method !== 'GET') {
        requestOptions.body = JSON.stringify(formState);
      }
      
      // Construir URL absoluta si es relativa y añadir query params
      const baseUrl = 'https://backend.makinari.com';
      let url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;
      
      if (method === 'GET' && Object.keys(formState).length > 0) {
        const queryParams = new URLSearchParams();
        Object.entries(formState).forEach(([key, value]) => {
          if (value !== null && value !== undefined && value !== '') {
            queryParams.append(key, String(value));
          }
        });
        url = `${url.split('?')[0]}?${queryParams.toString()}`;
      }
      
      const res = await fetch(url, requestOptions);
      const data = await res.json();
      
      setResponse(data);
      setActiveTab('response');
    } catch (err: any) {
      setError(err.message || 'Request failed');
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
      <form onSubmit={handleSubmit} className={styles.formInCard}>
        <div className={styles.formGroup} style={{ marginTop: '24px' }}>
          <label>
            API Key (Bearer Token) <span style={{ opacity: 0.6, fontWeight: 'normal', fontSize: '0.9em' }}>(required for server-to-server)</span>
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className={styles.formControl}
            placeholder="sk_prod_..."
            style={{ fontFamily: 'monospace' }}
          />
        </div>
        {Object.keys(formState).map((field) => {
          // Determinar si es requerido y otros metadatos
          const isRequired = String(description).includes('[required]');
          const isObject = typeof description === 'object';
          
          if (isObject) {
            // Manejar objetos anidados
            return (
              <div key={field} className={styles.requestSection}>
                <h4>{field}</h4>
                {Object.entries(description as Record<string, any>).map(([subField, subDesc]) => (
                  <div key={`${field}.${subField}`} className={styles.formGroup}>
                    <label>
                      {subField} {String(subDesc).includes('[required]') && <span className={styles.required}>*</span>}
                    </label>
                    <input
                      type="text"
                      value={formState[field]?.[subField] || ''}
                      onChange={(e) => {
                        const newValue = {...(formState[field] || {})};
                        newValue[subField] = e.target.value;
                        handleInputChange(field, newValue);
                      }}
                      className={styles.formControl}
                      placeholder={String(subDesc).replace(/\[.*?\]/g, '').trim()}
                    />
                  </div>
                ))}
              </div>
            );
          }
          
          // Campos básicos
          return (
            <div key={field} className={styles.formGroup}>
              <label>
                {field} {isRequired && <span className={styles.required}>*</span>}
              </label>
              <input
                type="text"
                value={formState[field] || ''}
                onChange={(e) => handleInputChange(field, e.target.value)}
                className={styles.formControl}
                placeholder={String(description).replace(/\[.*?\]/g, '').trim()}
                required={isRequired}
              />
            </div>
          );
        })}
        
        <div className={styles.formActions} style={{ justifyContent: 'flex-start' }}>
          <button
            type="submit"
            className={styles.submitButton}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className={styles.loadingSpinner}></span>
                Sending...
              </>
            ) : 'Send Request'}
          </button>
        </div>
      </form>
    );
  };
  
  const renderResponse = () => {
    if (error) {
      return (
        <div className={styles.errorMessage}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '1rem', fontWeight: 600 }}>Error</h4>
          <p style={{ margin: 0 }}>{error}</p>
        </div>
      );
    }
    
    if (!response) {
      return (
        <div className={styles.callout}>
          <div className={styles.calloutContent}>
            <p>No response available. Send a request first.</p>
          </div>
        </div>
      );
    }
    
    return (
      <div className={styles.responseContainer}>
        <pre className={styles.pre}>
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
      <div className={styles.requestDetails}>
        <div className={styles.requestSection}>
          <h4>JavaScript / TypeScript</h4>
          <pre className={styles.pre}>
{`// Fetch Example
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
        
        <div className={styles.requestSection}>
          <h4>Python</h4>
          <pre className={styles.pre}>
{`# Requests Example
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
    <div className={styles.requestPreview}>
      {description && (
        <div className={styles.callout} style={{ marginBottom: '0' }}>
          <div className={styles.calloutContent}>
            <p>{description}</p>
          </div>
        </div>
      )}
      
      <div className={styles.tabs}>
        <button
          className={`${styles.tabButton} ${activeTab === 'request' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('request')}
        >
          Request
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'response' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('response')}
        >
          Response
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'code' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('code')}
        >
          Code
        </button>
      </div>
      
      <div className={styles.tabContent}>
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
    <div className={styles.requestPreview}>
      <form onSubmit={handleSubmit} className={styles.formInCard}>
        <div className={styles.formGroup}>
          <label>Properties (JSON):</label>
          <textarea
            className={styles.textarea}
            value={properties}
            onChange={(e) => setProperties(e.target.value)}
            placeholder='{"events": [], "activity": []}'
            rows={4}
          />
        </div>
        <div className={styles.formActions} style={{ justifyContent: 'flex-start' }}>
          <button type="submit" className={styles.submitButton}>
            Send Request
          </button>
        </div>
      </form>
      {response && (
        <div className={styles.responseContainer} style={{ marginTop: '20px' }}>
          <pre className={styles.pre}>
            {JSON.stringify(response, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

export default DefaultApiTester;