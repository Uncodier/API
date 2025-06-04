'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props específicas para la API de GetTask
export interface GetTaskApiProps {
  defaultUserId?: string;
  defaultSiteId?: string;
  defaultLeadId?: string;
  defaultVisitorId?: string;
  defaultAgentId?: string;
  defaultCommandId?: string;
  defaultType?: string;
  defaultStatus?: string;
  defaultStage?: string;
  defaultPriority?: string;
  defaultSearch?: string;
  defaultSortBy?: string;
  defaultSortOrder?: string;
  defaultLimit?: number;
  defaultOffset?: number;
  defaultIncludeCompleted?: boolean;
  defaultIncludeArchived?: boolean;
}

// Estado específico para la API de GetTask
export interface GetTaskApiState {
  user_id: string;
  site_id: string;
  lead_id: string;
  visitor_id: string;
  agent_id: string;
  command_id: string;
  type: string;
  status: string;
  stage: string;
  priority: string;
  due_date_from: string;
  due_date_to: string;
  scheduled_date_from: string;
  scheduled_date_to: string;
  created_date_from: string;
  created_date_to: string;
  search: string;
  sort_by: string;
  sort_order: string;
  limit: number;
  offset: number;
  include_completed: boolean;
  include_archived: boolean;
}

// Configuración de la API de GetTask
const GetTaskApi: BaseApiConfig = {
  id: 'get-task',
  name: 'Get Tasks API',
  description: 'API para obtener tareas del sistema. Principalmente diseñada para trabajar con lead_id.',
  defaultEndpoint: '/api/agents/tools/getTask',

  // Obtener el estado inicial
  getInitialState: (props: GetTaskApiProps): GetTaskApiState => {
    return {
      lead_id: props.defaultLeadId || '',
      user_id: props.defaultUserId || '',
      site_id: props.defaultSiteId || '',
      visitor_id: props.defaultVisitorId || '',
      agent_id: props.defaultAgentId || '',
      command_id: props.defaultCommandId || '',
      type: props.defaultType || '',
      status: props.defaultStatus || '',
      stage: props.defaultStage || '',
      priority: props.defaultPriority || '',
      due_date_from: '',
      due_date_to: '',
      scheduled_date_from: '',
      scheduled_date_to: '',
      created_date_from: '',
      created_date_to: '',
      search: props.defaultSearch || '',
      sort_by: props.defaultSortBy || 'created_at',
      sort_order: props.defaultSortOrder || 'desc',
      limit: props.defaultLimit || 50,
      offset: props.defaultOffset || 0,
      include_completed: props.defaultIncludeCompleted ?? true,
      include_archived: props.defaultIncludeArchived ?? false
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: GetTaskApiState): Record<string, any> => {
    const body: Record<string, any> = {};
    
    // Solo incluir campos que tienen valores
    if (state.user_id) body.user_id = state.user_id;
    if (state.site_id) body.site_id = state.site_id;
    if (state.lead_id) body.lead_id = state.lead_id;
    if (state.visitor_id) body.visitor_id = state.visitor_id;
    if (state.agent_id) body.agent_id = state.agent_id;
    if (state.command_id) body.command_id = state.command_id;
    if (state.type) body.type = state.type;
    if (state.status) body.status = state.status;
    if (state.stage) body.stage = state.stage;
    if (state.priority && state.priority !== '') {
      const priorityNum = parseInt(state.priority, 10);
      if (!isNaN(priorityNum)) body.priority = priorityNum;
    }
    if (state.due_date_from) body.due_date_from = state.due_date_from;
    if (state.due_date_to) body.due_date_to = state.due_date_to;
    if (state.scheduled_date_from) body.scheduled_date_from = state.scheduled_date_from;
    if (state.scheduled_date_to) body.scheduled_date_to = state.scheduled_date_to;
    if (state.created_date_from) body.created_date_from = state.created_date_from;
    if (state.created_date_to) body.created_date_to = state.created_date_to;
    if (state.search) body.search = state.search;
    
    // Incluir campos de ordenamiento y paginación
    body.sort_by = state.sort_by;
    body.sort_order = state.sort_order;
    body.limit = state.limit;
    body.offset = state.offset;
    body.include_completed = state.include_completed;
    body.include_archived = state.include_archived;
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: GetTaskApiState;
    setState: React.Dispatch<React.SetStateAction<GetTaskApiState>>;
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof GetTaskApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
        <SectionLabel>Filtro Principal</SectionLabel>
        
        <FormField
          label="Lead ID (UUID) - Filtro Principal"
          id="lead_id"
          type="text"
          value={state.lead_id}
          onChange={(value) => handleChange('lead_id', value)}
          placeholder="abcdef12-3456-7890-abcd-ef1234567890"
        />
        
        <SectionLabel>Filtros Adicionales por Entidad</SectionLabel>
        
        <FormField
          label="Usuario (UUID)"
          id="user_id"
          type="text"
          value={state.user_id}
          onChange={(value) => handleChange('user_id', value)}
          placeholder="12345678-1234-1234-1234-123456789012"
        />
        
        <FormField
          label="Sitio (UUID)"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value) => handleChange('site_id', value)}
          placeholder="87654321-4321-4321-4321-210987654321"
        />
        
        <FormField
          label="Visitante (UUID)"
          id="visitor_id"
          type="text"
          value={state.visitor_id}
          onChange={(value) => handleChange('visitor_id', value)}
          placeholder="UUID del visitante"
        />
        
        <FormField
          label="Agente (UUID)"
          id="agent_id"
          type="text"
          value={state.agent_id}
          onChange={(value) => handleChange('agent_id', value)}
          placeholder="UUID del agente"
        />
        
        <FormField
          label="Comando (UUID)"
          id="command_id"
          type="text"
          value={state.command_id}
          onChange={(value) => handleChange('command_id', value)}
          placeholder="UUID del comando"
        />
        
        <SectionLabel>Filtros por Propiedades</SectionLabel>
        
        <FormField
          label="Tipo de Tarea"
          id="type"
          type="text"
          value={state.type}
          onChange={(value) => handleChange('type', value)}
          placeholder="Ej: call, email, demo, meeting, quote, follow_up, support, custom_type"
        />
        
        <FormField
          label="Estado"
          id="status"
          type="select"
          value={state.status}
          onChange={(value) => handleChange('status', value)}
          options={[
            { value: '', label: 'Todos los estados' },
            { value: 'active', label: 'Activa' },
            { value: 'inactive', label: 'Inactiva' },
            { value: 'archived', label: 'Archivada' }
          ]}
        />
        
        <FormField
          label="Etapa (Customer Journey)"
          id="stage"
          type="select"
          value={state.stage}
          onChange={(value) => handleChange('stage', value)}
          options={[
            { value: '', label: 'Todas las etapas' },
            { value: 'awareness', label: 'Awareness' },
            { value: 'consideration', label: 'Consideration' },
            { value: 'decision', label: 'Decision' },
            { value: 'purchase', label: 'Purchase' },
            { value: 'retention', label: 'Retention' },
            { value: 'referral', label: 'Referral' }
          ]}
        />
        
        <FormField
          label="Prioridad (Número entero)"
          id="priority"
          type="number"
          value={state.priority}
          onChange={(value) => handleChange('priority', value)}
          placeholder="Ej: 0 (baja), 5 (media), 10 (alta), 20 (urgente)"
        />
        
        <SectionLabel>Filtros por Fecha</SectionLabel>
        
        <FormField
          label="Fecha de Vencimiento - Desde"
          id="due_date_from"
          type="text"
          value={state.due_date_from}
          onChange={(value) => handleChange('due_date_from', value)}
          placeholder="2024-01-01T00:00:00Z"
        />
        
        <FormField
          label="Fecha de Vencimiento - Hasta"
          id="due_date_to"
          type="text"
          value={state.due_date_to}
          onChange={(value) => handleChange('due_date_to', value)}
          placeholder="2024-12-31T23:59:59Z"
        />
        
        <FormField
          label="Fecha Programada - Desde"
          id="scheduled_date_from"
          type="text"
          value={state.scheduled_date_from}
          onChange={(value) => handleChange('scheduled_date_from', value)}
          placeholder="2024-01-01T00:00:00Z"
        />
        
        <FormField
          label="Fecha Programada - Hasta"
          id="scheduled_date_to"
          type="text"
          value={state.scheduled_date_to}
          onChange={(value) => handleChange('scheduled_date_to', value)}
          placeholder="2024-12-31T23:59:59Z"
        />
        
        <FormField
          label="Fecha de Creación - Desde"
          id="created_date_from"
          type="text"
          value={state.created_date_from}
          onChange={(value) => handleChange('created_date_from', value)}
          placeholder="2024-01-01T00:00:00Z"
        />
        
        <FormField
          label="Fecha de Creación - Hasta"
          id="created_date_to"
          type="text"
          value={state.created_date_to}
          onChange={(value) => handleChange('created_date_to', value)}
          placeholder="2024-12-31T23:59:59Z"
        />
        
        <SectionLabel>Búsqueda y Ordenamiento</SectionLabel>
        
        <FormField
          label="Búsqueda en Título y Descripción"
          id="search"
          type="text"
          value={state.search}
          onChange={(value) => handleChange('search', value)}
          placeholder="Buscar en título y descripción..."
        />
        
        <FormField
          label="Ordenar Por"
          id="sort_by"
          type="select"
          value={state.sort_by}
          onChange={(value) => handleChange('sort_by', value)}
          options={[
            { value: 'created_at', label: 'Fecha de Creación' },
            { value: 'updated_at', label: 'Fecha de Actualización' },
            { value: 'due_date', label: 'Fecha de Vencimiento' },
            { value: 'scheduled_date', label: 'Fecha Programada' },
            { value: 'priority', label: 'Prioridad' },
            { value: 'title', label: 'Título' },
            { value: 'type', label: 'Tipo' },
            { value: 'status', label: 'Estado' }
          ]}
        />
        
        <FormField
          label="Orden"
          id="sort_order"
          type="select"
          value={state.sort_order}
          onChange={(value) => handleChange('sort_order', value)}
          options={[
            { value: 'desc', label: 'Descendente (más reciente primero)' },
            { value: 'asc', label: 'Ascendente (más antiguo primero)' }
          ]}
        />
        
        <SectionLabel>Paginación</SectionLabel>
        
        <FormField
          label="Límite de Resultados"
          id="limit"
          type="number"
          value={state.limit}
          onChange={(value) => handleChange('limit', value)}
          min={1}
          max={500}
        />
        
        <FormField
          label="Offset (Saltar)"
          id="offset"
          type="number"
          value={state.offset}
          onChange={(value) => handleChange('offset', value)}
          min={0}
        />
        
        <SectionLabel>Opciones de Inclusión</SectionLabel>
        
        <FormField
          label="Incluir Tareas Completadas"
          id="include_completed"
          type="checkbox"
          value={state.include_completed}
          onChange={(value) => handleChange('include_completed', value)}
        />
        
        <FormField
          label="Incluir Tareas Archivadas"
          id="include_archived"
          type="checkbox"
          value={state.include_archived}
          onChange={(value) => handleChange('include_archived', value)}
        />
      </>
    );
  }
};

export default GetTaskApi; 