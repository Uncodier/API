'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props específicas para la API de CreateTask
export interface CreateTaskApiProps {
  defaultTitle?: string;
  defaultDescription?: string;
  defaultType?: string;
  defaultStatus?: string;
  defaultStage?: string;
  defaultPriority?: string;
  defaultUserId?: string;
  defaultSiteId?: string;
  defaultLeadId?: string;
  defaultScheduledDate?: string;
  defaultCommandId?: string;
  defaultAmount?: number;
  defaultAddress?: string;
}

// Estado específico para la API de CreateTask
export interface CreateTaskApiState {
  title: string;
  description: string;
  type: string;
  status: string;
  stage: string;
  priority: string;
  user_id: string;
  site_id: string;
  lead_id: string;
  scheduled_date: string;
  command_id: string;
  amount: string;
  address: string; // JSON string
}

// Configuración de la API de CreateTask
const CreateTaskApi: BaseApiConfig = {
  id: 'create-task',
  name: 'Create Task API',
  description: 'API para crear nuevas tareas en el sistema',
  defaultEndpoint: '/api/agents/tools/tasks/create',

  // Obtener el estado inicial
  getInitialState: (props: CreateTaskApiProps): CreateTaskApiState => {
    return {
      title: props.defaultTitle || 'Seguimiento de lead',
      description: props.defaultDescription || 'Llamar al cliente para confirmar interés en el producto',
      type: props.defaultType || 'call',
      status: props.defaultStatus || 'pending',
      stage: props.defaultStage || 'consideration',
      priority: props.defaultPriority || 'medium',
      user_id: props.defaultUserId || '',
      site_id: props.defaultSiteId || '',
      lead_id: props.defaultLeadId || 'abcdef12-3456-7890-abcd-ef1234567890',
      scheduled_date: props.defaultScheduledDate || '2024-01-15T14:00:00Z',
      command_id: props.defaultCommandId || '',
      amount: props.defaultAmount?.toString() || '',
      address: props.defaultAddress || JSON.stringify({
        "street": "Av. Revolución 1425",
        "neighborhood": "Zona Rosa", 
        "city": "Ciudad de México",
        "state": "CDMX",
        "postal_code": "06600",
        "country": "México",
        "coordinates": {
          "lat": 19.4326,
          "lng": -99.1332
        }
      }, null, 2)
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: CreateTaskApiState): Record<string, any> => {
    const body: Record<string, any> = {
      title: state.title,
      type: state.type,
      lead_id: state.lead_id
    };
    
    // Campos opcionales
    if (state.description) body.description = state.description;
    if (state.status && state.status !== 'pending') body.status = state.status;
    if (state.stage && state.stage !== 'pending') body.stage = state.stage;
    if (state.priority && state.priority !== '') {
      const priorityNum = parseInt(state.priority, 10);
      if (!isNaN(priorityNum)) body.priority = priorityNum;
    }
    if (state.user_id) body.user_id = state.user_id;
    if (state.site_id) body.site_id = state.site_id;
    if (state.scheduled_date) body.scheduled_date = state.scheduled_date;
    if (state.command_id) body.command_id = state.command_id;
    
    // Manejar amount como número
    if (state.amount && state.amount !== '') {
      const amountNum = parseFloat(state.amount);
      if (!isNaN(amountNum)) body.amount = amountNum;
    }
    
    // Manejar address como JSON
    if (state.address && state.address.trim() !== '' && state.address !== '{}') {
      try {
        body.address = JSON.parse(state.address);
      } catch (error) {
        console.error('Error parsing address JSON:', error);
        // Si hay error, no incluir address
      }
    }
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: CreateTaskApiState;
    setState: React.Dispatch<React.SetStateAction<CreateTaskApiState>>;
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof CreateTaskApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
        <SectionLabel>Información Básica (Requerida)</SectionLabel>
        
        <FormField
          label="Lead ID (UUID) *"
          id="lead_id"
          type="text"
          value={state.lead_id}
          onChange={(value) => handleChange('lead_id', value)}
          placeholder="abcdef12-3456-7890-abcd-ef1234567890"
          required
        />
        
        <FormField
          label="Título *"
          id="title"
          type="text"
          value={state.title}
          onChange={(value) => handleChange('title', value)}
          placeholder="Título de la tarea"
          required
        />
        
        <FormField
          label="Tipo de Tarea *"
          id="type"
          type="text"
          value={state.type}
          onChange={(value) => handleChange('type', value)}
          placeholder="Ej: call, email, demo, meeting, quote, follow_up, support, custom_type"
          required
        />
        
        <SectionLabel>Asignación (Opcional - Se obtiene automáticamente del lead)</SectionLabel>
        
        <FormField
          label="Usuario Asignado (UUID)"
          id="user_id"
          type="text"
          value={state.user_id}
          onChange={(value) => handleChange('user_id', value)}
          placeholder="Se obtiene automáticamente del lead si se deja vacío"
        />
        
        <FormField
          label="Sitio (UUID)"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value) => handleChange('site_id', value)}
          placeholder="Se obtiene automáticamente del lead si se deja vacío"
        />
        
        <SectionLabel>Información Adicional (Opcional)</SectionLabel>
        
        <FormField
          label="Descripción"
          id="description"
          type="textarea"
          value={state.description}
          onChange={(value) => handleChange('description', value)}
          placeholder="Descripción detallada de la tarea"
          rows={3}
        />
        
        <FormField
          label="Prioridad (Número entero)"
          id="priority"
          type="number"
          value={state.priority}
          onChange={(value) => handleChange('priority', value)}
          placeholder="Ej: 0 (baja), 5 (media), 10 (alta), 20 (urgente)"
        />
        
        <FormField
          label="Estado"
          id="status"
          type="select"
          value={state.status}
          onChange={(value) => handleChange('status', value)}
          options={[
            { value: 'pending', label: 'Pendiente' },
            { value: 'in_progress', label: 'En Progreso' },
            { value: 'completed', label: 'Completada' },
            { value: 'failed', label: 'Fallida' }
          ]}
        />
        
        <FormField
          label="Etapa (Customer Journey)"
          id="stage"
          type="select"
          value={state.stage}
          onChange={(value) => handleChange('stage', value)}
          options={[
            { value: 'awareness', label: 'Awareness' },
            { value: 'consideration', label: 'Consideration' },
            { value: 'decision', label: 'Decision' },
            { value: 'purchase', label: 'Purchase' },
            { value: 'retention', label: 'Retention' },
            { value: 'referral', label: 'Referral' }
          ]}
        />
        
        <SectionLabel>Fechas y Programación</SectionLabel>
        
        <FormField
          label="Fecha Programada (ISO 8601)"
          id="scheduled_date"
          type="text"
          value={state.scheduled_date}
          onChange={(value) => handleChange('scheduled_date', value)}
          placeholder="2024-01-15T14:00:00Z"
        />
        
        <FormField
          label="Monto/Valor"
          id="amount"
          type="number"
          value={state.amount}
          onChange={(value) => handleChange('amount', value)}
          placeholder="Ej: 1500.50"
        />
        
        <FormField
          label="Dirección (JSON)"
          id="address"
          type="textarea"
          value={state.address}
          onChange={(value) => handleChange('address', value)}
          placeholder='Ejemplos:\n• Básica: {"street": "123 Main St", "city": "New York", "country": "USA"}\n• Negocio: {"company": "Tech Corp", "street": "456 Ave", "floor": "5to", "city": "CDMX"}\n• Virtual: {"type": "virtual", "platform": "Zoom", "meeting_url": "https://zoom.us/j/123"}'
          rows={6}
        />
        
        <SectionLabel>Referencias del Sistema</SectionLabel>
        
        <FormField
          label="ID de Comando (UUID)"
          id="command_id"
          type="text"
          value={state.command_id}
          onChange={(value) => handleChange('command_id', value)}
          placeholder="UUID del comando que generó esta tarea"
        />
      </>
    );
  }
};

export default CreateTaskApi; 