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

// Props específicas para la API de envío de WhatsApp
export interface SendWhatsAppApiProps {
  defaultPhoneNumber?: string;
  defaultMessage?: string;
  defaultFrom?: string;
  defaultSiteId?: string;
  defaultAgentId?: string;
  defaultConversationId?: string;
  defaultLeadId?: string;
}

// Estado específico para la API de envío de WhatsApp
export interface SendWhatsAppApiState {
  phone_number: string;
  message: string;
  from: string;
  site_id: string;
  agent_id: string;
  conversation_id: string;
  lead_id: string;
}

// Función para validar número de teléfono
const isValidPhoneNumber = (phone: string): boolean => {
  const phoneRegex = /^\+\d{10,15}$/;
  return phoneRegex.test(phone);
};

// Configuración de la API de envío de WhatsApp
const SendWhatsAppApi: BaseApiConfig = {
  id: 'send-whatsapp' as ApiType,
  name: 'Envío de Mensaje WhatsApp',
  description: 'API para enviar mensajes de WhatsApp desde un agente AI',
  defaultEndpoint: '/api/agents/tools/sendWhatsApp',

  // Obtener el estado inicial
  getInitialState: (props: SendWhatsAppApiProps): SendWhatsAppApiState => {
    return {
      phone_number: props.defaultPhoneNumber || '+1234567890',
      message: props.defaultMessage || 'Hola! Gracias por tu interés en nuestro producto. ¿Cómo puedo ayudarte hoy?',
      from: props.defaultFrom || 'AI Assistant',
      site_id: props.defaultSiteId || 'site-12345',
      agent_id: props.defaultAgentId || '',
      conversation_id: props.defaultConversationId || '',
      lead_id: props.defaultLeadId || ''
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: SendWhatsAppApiState): Record<string, any> => {
    const body: Record<string, any> = { 
      phone_number: state.phone_number,
      message: state.message,
      site_id: state.site_id
    };
    
    // Agregar campos opcionales solo si tienen valor
    if (state.from) body.from = state.from;
    if (state.agent_id) body.agent_id = state.agent_id;
    if (state.conversation_id) body.conversation_id = state.conversation_id;
    if (state.lead_id) body.lead_id = state.lead_id;
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: SendWhatsAppApiState;
    setState: React.Dispatch<React.SetStateAction<SendWhatsAppApiState>>;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof SendWhatsAppApiState, value: string) => {
      setState(prev => ({ ...prev, [field]: value }));
    };

    // Validaciones en tiempo real
    const phoneError = state.phone_number && !isValidPhoneNumber(state.phone_number) && state.phone_number !== 'no-phone-example' 
      ? 'Formato de teléfono inválido. Use formato internacional: +1234567890' : '';
    
    return (
      <>
        <SectionLabel>Datos del Mensaje WhatsApp (Obligatorios)</SectionLabel>
        
        <FormField
          label="Número de Teléfono *"
          id="phone_number"
          type="text"
          value={state.phone_number}
          onChange={(value: string) => handleChange('phone_number', value)}
          placeholder="+1234567890"
          required
        />
        {phoneError && <div style={{ color: 'red', fontSize: '12px', marginTop: '5px' }}>{phoneError}</div>}
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          Use 'no-phone-example' para pruebas sin envío real
        </div>
        
        <FormField
          label="Mensaje *"
          id="message"
          type="textarea"
          value={state.message}
          onChange={(value: string) => handleChange('message', value)}
          placeholder="Escribe tu mensaje aquí..."
          rows={6}
          required
        />
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          El mensaje se enviará tal como se escriba via WhatsApp
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
          ID del sitio para obtener la configuración de WhatsApp
        </div>
        
        <SectionLabel>Datos Opcionales (Para Logging)</SectionLabel>
        
        <FormField
          label="Nombre del Remitente"
          id="from"
          type="text"
          value={state.from}
          onChange={(value: string) => handleChange('from', value)}
          placeholder="AI Assistant"
        />
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          Nombre que aparecerá como remitente del mensaje
        </div>
        
        <FormField
          label="ID del Agente"
          id="agent_id"
          type="text"
          value={state.agent_id}
          onChange={(value: string) => handleChange('agent_id', value)}
          placeholder="agent-12345"
        />
        <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
          ID del agente que envía el mensaje
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
            <SectionLabel>Vista Previa del Mensaje WhatsApp</SectionLabel>
            <div style={{
              border: '1px solid #25D366',
              borderRadius: '10px',
              padding: '15px',
              backgroundColor: '#f0f8ff',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              fontSize: '14px',
              marginBottom: '15px'
            }}>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                marginBottom: '10px',
                fontSize: '12px',
                color: '#666'
              }}>
                <div style={{
                  width: '20px',
                  height: '20px',
                  borderRadius: '50%',
                  backgroundColor: '#25D366',
                  marginRight: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                  fontSize: '10px'
                }}>
                  W
                </div>
                <strong>{state.from || 'AI Assistant'}</strong>
                <span style={{ marginLeft: '10px', fontSize: '11px' }}>
                  Para: {state.phone_number}
                </span>
              </div>
              
              <div style={{
                backgroundColor: '#DCF8C6',
                padding: '10px 12px',
                borderRadius: '8px',
                marginLeft: '28px'
              }}>
                <div style={{ whiteSpace: 'pre-line', lineHeight: '1.4' }}>
                  {state.message}
                </div>
                <div style={{ 
                  fontSize: '11px', 
                  color: '#666', 
                  textAlign: 'right', 
                  marginTop: '5px' 
                }}>
                  {new Date().toLocaleTimeString('es-ES', { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                  })}
                </div>
              </div>
            </div>
          </>
        )}
        
        {/* Indicador de número temporal */}
        {state.phone_number === 'no-phone-example' && (
          <div style={{
            padding: '10px',
            backgroundColor: '#fff3cd',
            border: '1px solid #ffeaa7',
            borderRadius: '5px',
            color: '#856404',
            fontSize: '14px',
            marginBottom: '15px'
          }}>
            <strong>⚠️ Número Temporal Detectado:</strong> No se enviará mensaje real por WhatsApp. 
            La respuesta simulará un envío exitoso para propósitos de testing.
          </div>
        )}
      </>
    );
  }
};

export default SendWhatsAppApi; 