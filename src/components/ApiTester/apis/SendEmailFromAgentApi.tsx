'use client';

import React from 'react';
import { BaseApiConfig, ApiType } from '../types';
import { FormField } from '../components/FormComponents';

// Componente SectionLabel simple
const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div style={{ 
    fontWeight: 'bold', 
    fontSize: '16px', 
    marginTop: '20px', 
    marginBottom: '10px',
    color: '#333'
  }}>
    {children}
  </div>
);

// Props específicas para la API de envío de emails
export interface SendEmailFromAgentApiProps {
  defaultEmail?: string;
  defaultFrom?: string;
  defaultSubject?: string;
  defaultMessage?: string;
  defaultSiteId?: string;
  defaultAgentId?: string;
  defaultConversationId?: string;
  defaultLeadId?: string;
}

// Estado específico para la API de envío de emails
export interface SendEmailFromAgentApiState {
  email: string;
  from: string;
  subject: string;
  message: string;
  site_id: string;
  agent_id: string;
  conversation_id: string;
  lead_id: string;
}

// Función para validar email
const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Configuración de la API de envío de emails
const SendEmailFromAgentApi: BaseApiConfig = {
  id: 'send-email-from-agent' as ApiType,
  name: 'Envío de Email desde Agente',
  description: 'API para enviar emails automáticamente desde un agente AI',
  defaultEndpoint: '/api/agents/tools/sendEmail',

  // Obtener el estado inicial
  getInitialState: (props: SendEmailFromAgentApiProps): SendEmailFromAgentApiState => {
    return {
      email: props.defaultEmail || 'cliente@empresa.com',
      from: props.defaultFrom || 'ventas@miempresa.com',
      subject: props.defaultSubject || 'Propuesta comercial personalizada',
      message: props.defaultMessage || 'Estimado cliente,\n\nEsperamos que se encuentre bien. Nos complace presentarle nuestra propuesta comercial personalizada basada en sus necesidades específicas.\n\nAdjuntamos los detalles de nuestra solución que incluye:\n- Análisis de requerimientos\n- Propuesta técnica\n- Cronograma de implementación\n- Presupuesto detallado\n\nQuedamos atentos a sus comentarios.\n\nSaludos cordiales,\nEquipo de Ventas',
      site_id: props.defaultSiteId || 'site-12345',
      agent_id: props.defaultAgentId || '',
      conversation_id: props.defaultConversationId || '',
      lead_id: props.defaultLeadId || ''
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: SendEmailFromAgentApiState): Record<string, any> => {
    const body: Record<string, any> = { 
      email: state.email,
      from: state.from,
      subject: state.subject,
      message: state.message,
      site_id: state.site_id
    };
    
    // Agregar campos opcionales solo si tienen valor
    if (state.agent_id) body.agent_id = state.agent_id;
    if (state.conversation_id) body.conversation_id = state.conversation_id;
    if (state.lead_id) body.lead_id = state.lead_id;
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: SendEmailFromAgentApiState;
    setState: React.Dispatch<React.SetStateAction<SendEmailFromAgentApiState>>;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof SendEmailFromAgentApiState, value: string) => {
      setState(prev => ({ ...prev, [field]: value }));
    };

    // Validaciones en tiempo real
    const emailError = state.email && !isValidEmail(state.email) && state.email !== 'no-email@example.com' 
      ? 'Formato de email inválido' : '';
    const fromError = state.from && !isValidEmail(state.from) 
      ? 'Formato de email inválido' : '';
    
    return (
      <>
        <SectionLabel>Datos del Email (Obligatorios)</SectionLabel>
        
        <FormField
          label="Email del Destinatario *"
          id="email"
          type="text"
          value={state.email}
          onChange={(value: string) => handleChange('email', value)}
          placeholder="cliente@empresa.com"
          required
        />
        {emailError && <div style={{ color: 'red', fontSize: '12px', marginTop: '5px' }}>{emailError}</div>}
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          Use 'no-email@example.com' para pruebas sin envío real
        </div>
        
        <FormField
          label="Email del Remitente *"
          id="from"
          type="text"
          value={state.from}
          onChange={(value: string) => handleChange('from', value)}
          placeholder="ventas@miempresa.com"
          required
        />
        {fromError && <div style={{ color: 'red', fontSize: '12px', marginTop: '5px' }}>{fromError}</div>}
        
        <FormField
          label="Asunto *"
          id="subject"
          type="text"
          value={state.subject}
          onChange={(value: string) => handleChange('subject', value)}
          placeholder="Asunto del email"
          required
        />
        
        <FormField
          label="Mensaje *"
          id="message"
          type="textarea"
          value={state.message}
          onChange={(value: string) => handleChange('message', value)}
          placeholder="Contenido del mensaje..."
          rows={8}
          required
        />
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          El mensaje se convertirá automáticamente a HTML con formato profesional
        </div>
        
        <FormField
          label="ID del Sitio *"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value: string) => handleChange('site_id', value)}
          placeholder="site-12345"
          required
        />
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          ID del sitio para obtener la configuración SMTP
        </div>
        
        <SectionLabel>Datos Opcionales (Para Logging)</SectionLabel>
        
        <FormField
          label="ID del Agente"
          id="agent_id"
          type="text"
          value={state.agent_id}
          onChange={(value: string) => handleChange('agent_id', value)}
          placeholder="agent-12345"
        />
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          ID del agente que envía el email
        </div>
        
        <FormField
          label="ID de la Conversación"
          id="conversation_id"
          type="text"
          value={state.conversation_id}
          onChange={(value: string) => handleChange('conversation_id', value)}
          placeholder="conv-12345"
        />
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          ID de la conversación relacionada
        </div>
        
        <FormField
          label="ID del Lead"
          id="lead_id"
          type="text"
          value={state.lead_id}
          onChange={(value: string) => handleChange('lead_id', value)}
          placeholder="lead-12345"
        />
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          ID del lead relacionado
        </div>
        
        {/* Vista previa del mensaje */}
        {state.message && (
          <>
            <SectionLabel>Vista Previa del Mensaje</SectionLabel>
            <div style={{
              border: '1px solid #e0e0e0',
              borderRadius: '5px',
              padding: '15px',
              backgroundColor: '#f9f9f9',
              fontFamily: 'Arial, sans-serif',
              fontSize: '14px',
              marginBottom: '15px'
            }}>
              <div style={{ marginBottom: '15px', fontWeight: 'bold' }}>
                Para: {state.email}
              </div>
              <div style={{ marginBottom: '15px', fontWeight: 'bold' }}>
                De: AI Assistant &lt;{state.from}&gt;
              </div>
              <div style={{ marginBottom: '15px', fontWeight: 'bold' }}>
                Asunto: {state.subject}
              </div>
              <hr style={{ margin: '15px 0', border: 'none', borderTop: '1px solid #ddd' }} />
              <div style={{ whiteSpace: 'pre-line' }}>
                {state.message}
              </div>
              <hr style={{ margin: '15px 0', border: 'none', borderTop: '1px solid #ddd' }} />
              <div style={{ fontSize: '12px', color: '#777', textAlign: 'center' }}>
                Este email fue enviado automaticamente por nuestro asistente AI.
              </div>
            </div>
          </>
        )}
        
        {/* Indicador de email temporal */}
        {state.email === 'no-email@example.com' && (
          <div style={{
            padding: '10px',
            backgroundColor: '#fff3cd',
            border: '1px solid #ffeaa7',
            borderRadius: '5px',
            color: '#856404',
            fontSize: '14px',
            marginBottom: '15px'
          }}>
            <strong>⚠️ Email Temporal Detectado:</strong> No se enviará email real. 
            La respuesta simulará un envío exitoso para propósitos de testing.
          </div>
        )}
      </>
    );
  }
};

export default SendEmailFromAgentApi; 