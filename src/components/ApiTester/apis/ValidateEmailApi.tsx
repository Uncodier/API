'use client';

import React from 'react';
import { BaseApiConfig, ApiType } from '../types';
import { FormField } from '../components/FormComponents';

// Props específicas para la API de validación de emails
export interface ValidateEmailApiProps {
  defaultEmail?: string;
}

// Estado específico para la API de validación de emails
export interface ValidateEmailApiState {
  email: string;
}

// Función para validar formato de email
const isValidEmailFormat = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Configuración de la API de validación de emails
const ValidateEmailApi: BaseApiConfig = {
  id: 'validate-email' as ApiType,
  name: 'Validate Email',
  description: 'Validates email addresses using SMTP protocol and MX record lookup',
  method: 'POST',
  endpoint: '/api/agents/tools/validateEmail',
  
  // Estado inicial
  getInitialState: (props: ValidateEmailApiProps = {}): ValidateEmailApiState => ({
    email: props.defaultEmail || ''
  }),

  // Construir el cuerpo de la petición
  buildRequestBody: (state: ValidateEmailApiState): Record<string, any> => {
    return {
      email: state.email
    };
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: ValidateEmailApiState;
    setState: React.Dispatch<React.SetStateAction<ValidateEmailApiState>>;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof ValidateEmailApiState, value: string) => {
      setState(prev => ({ ...prev, [field]: value }));
    };

    // Validación en tiempo real
    const emailError = state.email && !isValidEmailFormat(state.email) 
      ? 'Invalid email format' : '';
    
    return (
      <>
        <div style={{ 
          fontWeight: 'bold', 
          fontSize: '16px', 
          marginTop: '20px', 
          marginBottom: '10px',
          color: '#333'
        }}>
          Email Validation
        </div>
        
        <FormField
          label="Email Address *"
          id="email"
          type="email"
          value={state.email}
          onChange={(value: string) => handleChange('email', value)}
          placeholder="user@example.com"
          required
        />
        {emailError && (
          <div style={{ color: 'red', fontSize: '12px', marginTop: '5px' }}>
            {emailError}
          </div>
        )}
        
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          Enter an email address to validate using SMTP protocol and MX record lookup
        </div>
        
        <div style={{ 
          marginTop: '15px',
          padding: '10px',
          backgroundColor: '#f8f9fa',
          borderRadius: '4px',
          fontSize: '12px',
          color: '#666'
        }}>
          <strong>Validation Process:</strong>
          <ul style={{ margin: '5px 0', paddingLeft: '20px' }}>
            <li>Format validation using regex</li>
            <li>Disposable email provider detection</li>
            <li>MX record lookup for domain</li>
            <li>SMTP connection to mail server</li>
            <li>RCPT TO command validation</li>
          </ul>
        </div>
      </>
    );
  },

  // Validar el estado antes de enviar
  validateState: (state: ValidateEmailApiState): string | null => {
    if (!state.email) {
      return 'Email address is required';
    }
    
    if (!isValidEmailFormat(state.email)) {
      return 'Please enter a valid email address';
    }
    
    return null;
  },

  // Procesar la respuesta
  processResponse: (response: any) => {
    if (response.success && response.data) {
      const { data } = response;
      
      // Formatear la respuesta para mostrar información útil
      const formattedResponse = {
        ...response,
        formatted: {
          email: data.email,
          isValid: data.isValid,
          result: data.result,
          message: data.message,
          executionTime: `${data.execution_time}ms`,
          flags: data.flags.length > 0 ? data.flags.join(', ') : 'None',
          timestamp: new Date(data.timestamp).toLocaleString()
        }
      };
      
      return formattedResponse;
    }
    
    return response;
  },

  // Ejemplos de código
  getCodeExamples: (state: ValidateEmailApiState) => ({
    curl: `curl -X POST "${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/agents/tools/validateEmail" \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "${state.email}"
  }'`,
    
    javascript: `const response = await fetch('/api/agents/tools/validateEmail', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    email: '${state.email}'
  })
});

const result = await response.json();
console.log(result);`,
    
    python: `import requests
import json

url = '${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/agents/tools/validateEmail'
data = {
    'email': '${state.email}'
}

response = requests.post(url, json=data)
result = response.json()
print(result)`,
    
    php: `<?php
$url = '${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/agents/tools/validateEmail';
$data = array(
    'email' => '${state.email}'
);

$options = array(
    'http' => array(
        'header'  => "Content-type: application/json\\r\\n",
        'method'  => 'POST',
        'content' => json_encode($data)
    )
);

$context = stream_context_create($options);
$result = file_get_contents($url, false, $context);
$response = json_decode($result, true);
print_r($response);
?>`
  })
};

export default ValidateEmailApi;
