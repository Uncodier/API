'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props específicas para la API Lead Attention
export interface LeadAttentionApiProps {
  defaultLeadId?: string;
  defaultMessage?: string;
  defaultChannel?: string;
  defaultPriority?: string;
}

// Estado específico para la API Lead Attention
export interface LeadAttentionApiState {
  lead_id: string;
  message: string;
  channel: 'email' | 'whatsapp' | 'phone' | 'chat' | 'form' | 'other';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  contact_info: {
    email: string;
    phone: string;
    contact_method: string;
  };
  additional_data: string; // JSON string
}

// Configuración de la API Lead Attention
const LeadAttentionApi: BaseApiConfig = {
  id: 'general',
  name: 'Lead Attention Notification',
  description: 'Notifica automáticamente al team member asignado cuando un lead requiere atención. Solo necesitas el lead_id.',
  defaultEndpoint: '/api/notifications/leadAttention',

  // Obtener el estado inicial
  getInitialState: (props: LeadAttentionApiProps): LeadAttentionApiState => {
    return {
      lead_id: props.defaultLeadId || '',
      message: props.defaultMessage || '',
      channel: (props.defaultChannel as any) || 'other',
      priority: (props.defaultPriority as any) || 'normal',
      contact_info: {
        email: '',
        phone: '',
        contact_method: ''
      },
      additional_data: '{}'
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: LeadAttentionApiState): Record<string, any> => {
    const body: Record<string, any> = {
      lead_id: state.lead_id,
      channel: state.channel,
      priority: state.priority
    };
    
    // Agregar message si no está vacío
    if (state.message && state.message.trim()) {
      body.message = state.message;
    }
    
    // Agregar contact_info si tiene al menos un campo
    if (state.contact_info.email || state.contact_info.phone || state.contact_info.contact_method) {
      body.contact_info = {
        ...(state.contact_info.email && { email: state.contact_info.email }),
        ...(state.contact_info.phone && { phone: state.contact_info.phone }),
        ...(state.contact_info.contact_method && { contact_method: state.contact_info.contact_method })
      };
    }
    
    // Agregar additional_data si es un JSON válido
    if (state.additional_data && state.additional_data.trim() !== '{}') {
      try {
        body.additional_data = JSON.parse(state.additional_data);
      } catch (e) {
        // Si no es JSON válido, no incluir el campo
      }
    }
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: LeadAttentionApiState;
    setState: React.Dispatch<React.SetStateAction<LeadAttentionApiState>>;
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof LeadAttentionApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    const handleContactInfoChange = (field: keyof LeadAttentionApiState['contact_info'], value: string) => {
      setState(prev => ({
        ...prev,
        contact_info: { ...prev.contact_info, [field]: value }
      }));
    };

    const loadExample = () => {
      setState(prev => ({
        ...prev,
        lead_id: '550e8400-e29b-41d4-a716-446655440001',
        message: 'Hi there! I\'m interested in your services and would like to schedule a demo. Could you please contact me at your earliest convenience? I\'m available Monday through Friday between 9 AM and 5 PM.',
        channel: 'email',
        priority: 'high',
        contact_info: {
          email: 'john.doe@example.com',
          phone: '+1-555-123-4567',
          contact_method: 'Email preferred, but phone is also fine'
        },
        additional_data: JSON.stringify({
          source: 'Contact form',
          page: '/contact',
          utm_source: 'google',
          utm_medium: 'cpc',
          utm_campaign: 'lead_gen',
          browser: 'Chrome',
          device: 'Desktop',
          timestamp: new Date().toISOString()
        }, null, 2)
      }));
    };

    const loadMinimalExample = () => {
      setState(prev => ({
        ...prev,
        lead_id: '550e8400-e29b-41d4-a716-446655440001',
        message: '',
        channel: 'other',
        priority: 'normal',
        contact_info: {
          email: '',
          phone: '',
          contact_method: ''
        },
        additional_data: '{}'
      }));
    };
    
    return (
      <>
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={loadExample}
            className="bg-gray-600 text-white py-2 px-4 rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500"
          >
            Cargar Ejemplo Completo
          </button>
          <button
            type="button"
            onClick={loadMinimalExample}
            className="bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Cargar Ejemplo Mínimo
          </button>
        </div>

        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-md">
          <h4 className="font-semibold text-blue-800 mb-2">ℹ️ Información Importante</h4>
          <p className="text-blue-700 text-sm">
            Esta API simplificada solo requiere el <strong>lead_id</strong>. 
            El sistema automáticamente:
          </p>
          <ul className="text-blue-700 text-sm mt-2 list-disc list-inside">
            <li>Identifica al team member asignado al lead</li>
            <li>Obtiene la información del sitio asociado</li>
            <li>Genera un mensaje por defecto si no se proporciona</li>
            <li>Envía la notificación por email al team member</li>
          </ul>
        </div>

        <SectionLabel>Información Requerida</SectionLabel>
        
        <FormField
          label="Lead ID (Requerido)"
          id="lead_id"
          type="text"
          value={state.lead_id}
          onChange={(value) => handleChange('lead_id', value)}
          placeholder="550e8400-e29b-41d4-a716-446655440001"
        />

        <SectionLabel>Configuración Opcional</SectionLabel>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            label="Canal"
            id="channel"
            type="select"
            value={state.channel}
            onChange={(value) => handleChange('channel', value)}
            options={[
              { value: 'other', label: '🔔 Other (Default)' },
              { value: 'email', label: '📧 Email' },
              { value: 'whatsapp', label: '📱 WhatsApp' },
              { value: 'phone', label: '☎️ Phone' },
              { value: 'chat', label: '💬 Chat' },
              { value: 'form', label: '📝 Form' }
            ]}
          />
          
          <FormField
            label="Prioridad"
            id="priority"
            type="select"
            value={state.priority}
            onChange={(value) => handleChange('priority', value)}
            options={[
              { value: 'normal', label: '📋 Normal (Default)' },
              { value: 'low', label: '🔽 Low' },
              { value: 'high', label: '🔺 High' },
              { value: 'urgent', label: '🚨 Urgent' }
            ]}
          />
        </div>

        <FormField
          label="Mensaje (Opcional)"
          id="message"
          type="textarea"
          value={state.message}
          onChange={(value) => handleChange('message', value)}
          placeholder="Si no se proporciona, se generará un mensaje por defecto..."
          rows={3}
        />

        <SectionLabel>Información de Contacto (Opcional)</SectionLabel>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            label="Email"
            id="contact_email"
            type="text"
            value={state.contact_info.email}
            onChange={(value) => handleContactInfoChange('email', value)}
            placeholder="john.doe@example.com"
          />
          
          <FormField
            label="Teléfono"
            id="contact_phone"
            type="text"
            value={state.contact_info.phone}
            onChange={(value) => handleContactInfoChange('phone', value)}
            placeholder="+1-555-123-4567"
          />
        </div>

        <FormField
          label="Método de Contacto Preferido"
          id="contact_method"
          type="text"
          value={state.contact_info.contact_method}
          onChange={(value) => handleContactInfoChange('contact_method', value)}
          placeholder="Email preferred, but phone is also fine"
        />

        <SectionLabel>Datos Adicionales (Opcional)</SectionLabel>
        
        <FormField
          label="Additional Data (JSON)"
          id="additional_data"
          type="textarea"
          value={state.additional_data}
          onChange={(value) => handleChange('additional_data', value)}
          placeholder='{"source": "Contact form", "page": "/contact"}'
          rows={6}
        />
      </>
    );
  }
};

export default LeadAttentionApi; 