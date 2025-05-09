'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField } from '../components/FormComponents';

// Props específicas para el API de CMO Stakeholder Coordination
export interface CmoStakeholderCoordinationApiProps {
  defaultEndpoint?: string;
}

// Estado específico para el API de CMO Stakeholder Coordination
export interface CmoStakeholderCoordinationApiState {
  meeting_title?: string;
  meeting_objective?: string;
  participants: string[];
  meeting_agenda: string;
  visitor_id?: string;
  lead_id?: string;
  userId?: string;
  conversationId?: string;
  agentId?: string;
  site_id: string;
  include_context_summary: boolean;
  phone_numbers: string[];
}

// Configuración de la API de CMO Stakeholder Coordination
const CmoStakeholderCoordinationApi: BaseApiConfig = {
  id: 'cmo-stakeholder-coordination',
  name: 'API de CMO Stakeholder Coordination',
  description: 'API para orquestar llamadas con stakeholders, generar resúmenes de reuniones y crear tareas y requisitos',
  defaultEndpoint: '/api/agents/cmo/stakeholder-coordination',

  // Obtener el estado inicial
  getInitialState: (props: CmoStakeholderCoordinationApiProps): CmoStakeholderCoordinationApiState => {
    return {
      participants: ['jane.smith@example.com', 'john.davis@example.com'],
      meeting_agenda: '1. Review Q1 campaign performance\n2. Discuss Q2 priorities\n3. Allocate budget for upcoming initiatives',
      site_id: 'site_456',
      userId: 'user_789',
      include_context_summary: true,
      phone_numbers: []
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: CmoStakeholderCoordinationApiState): Record<string, any> => {
    const body: Record<string, any> = {
      participants: state.participants,
      meeting_agenda: state.meeting_agenda,
      site_id: state.site_id,
      include_context_summary: state.include_context_summary
    };
    
    if (state.meeting_title) body.meeting_title = state.meeting_title;
    if (state.meeting_objective) body.meeting_objective = state.meeting_objective;
    if (state.visitor_id) body.visitor_id = state.visitor_id;
    if (state.lead_id) body.lead_id = state.lead_id;
    if (state.userId) body.userId = state.userId;
    if (state.conversationId) body.conversationId = state.conversationId;
    if (state.agentId) body.agentId = state.agentId;
    if (state.phone_numbers && state.phone_numbers.length > 0) body.phone_numbers = state.phone_numbers;
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: CmoStakeholderCoordinationApiState;
    setState: React.Dispatch<React.SetStateAction<CmoStakeholderCoordinationApiState>>;
  }) => {
    const { state, setState } = props;
    
    // Función para manejar cambios en los campos
    const handleChange = (field: string, value: any) => {
      setState((prev: any) => ({
        ...prev,
        [field]: value
      }));
    };

    // Función para manejar cambios en los participantes
    const handleParticipantsChange = (value: string) => {
      let participants: string[] = [];

      // Si el valor es una cadena, dividirlo por líneas o comas
      if (typeof value === 'string') {
        participants = value
          .split(/[\n,]/)
          .map(email => email.trim())
          .filter(email => email.length > 0);
      }

      setState((prev: any) => ({
        ...prev,
        participants
      }));
    };
    
    // Función para manejar cambios en los números de teléfono
    const handlePhoneNumbersChange = (value: string) => {
      let phoneNumbers: string[] = [];

      // Si el valor es una cadena, dividirlo por líneas o comas
      if (typeof value === 'string') {
        phoneNumbers = value
          .split(/[\n,]/)
          .map(phone => phone.trim())
          .filter(phone => phone.length > 0);
      }

      setState((prev: any) => ({
        ...prev,
        phone_numbers: phoneNumbers
      }));
    };
    
    return (
      <>
        <FormField
          label="Título de la Reunión (opcional - generado dinámicamente si no se proporciona)"
          id="meeting_title"
          type="text"
          value={state.meeting_title || ''}
          onChange={(value: any) => handleChange('meeting_title', value)}
          placeholder="Q2 Marketing Strategy Alignment"
        />
        
        <FormField
          label="Objetivo de la Reunión (opcional - generado dinámicamente si no se proporciona)"
          id="meeting_objective"
          type="text"
          value={state.meeting_objective || ''}
          onChange={(value: any) => handleChange('meeting_objective', value)}
          placeholder="Align on Q2 priorities and reallocate budget"
        />
        
        <FormField
          label="Participantes (uno por línea o separados por comas)"
          id="participants"
          type="textarea"
          value={state.participants.join('\n')}
          onChange={handleParticipantsChange}
          placeholder="jane.smith@example.com\njohn.davis@example.com"
        />
        
        <FormField
          label="Números de Teléfono para Llamada (uno por línea o separados por comas)"
          id="phone_numbers"
          type="textarea"
          value={state.phone_numbers ? state.phone_numbers.join('\n') : ''}
          onChange={handlePhoneNumbersChange}
          placeholder="+1234567890\n+0987654321"
        />
        
        <FormField
          label="Agenda de la Reunión"
          id="meeting_agenda"
          type="textarea"
          value={state.meeting_agenda}
          onChange={(value: any) => handleChange('meeting_agenda', value)}
          placeholder="1. Review Q1 campaign performance\n2. Discuss Q2 priorities\n3. Allocate budget for upcoming initiatives"
        />
        
        <FormField
          label="ID del Visitante (opcional)"
          id="visitor_id"
          type="text"
          value={state.visitor_id || ''}
          onChange={(value: any) => handleChange('visitor_id', value)}
          placeholder="visitor_789"
        />
        
        <FormField
          label="ID del Lead (opcional)"
          id="lead_id"
          type="text"
          value={state.lead_id || ''}
          onChange={(value: any) => handleChange('lead_id', value)}
          placeholder="lead_123"
        />
        
        <FormField
          label="ID del Usuario (opcional)"
          id="userId"
          type="text"
          value={state.userId || ''}
          onChange={(value: any) => handleChange('userId', value)}
          placeholder="user_789"
        />
        
        <FormField
          label="ID de la Conversación (opcional)"
          id="conversationId"
          type="text"
          value={state.conversationId || ''}
          onChange={(value: any) => handleChange('conversationId', value)}
          placeholder="conv_123456"
        />
        
        <FormField
          label="ID del Agente (opcional)"
          id="agentId"
          type="text"
          value={state.agentId || ''}
          onChange={(value: any) => handleChange('agentId', value)}
          placeholder="agent_cmo_123"
        />
        
        <FormField
          label="ID del Sitio"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value: any) => handleChange('site_id', value)}
          placeholder="site_456"
          required
        />
        
        <FormField
          label="Incluir Resumen de Contexto"
          id="include_context_summary"
          type="checkbox"
          value={state.include_context_summary}
          onChange={(value: any) => handleChange('include_context_summary', value)}
        />
      </>
    );
  }
};

export default CmoStakeholderCoordinationApi; 