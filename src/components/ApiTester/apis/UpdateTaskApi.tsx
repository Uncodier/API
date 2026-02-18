import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Tipos específicos para UpdateTask API
export interface UpdateTaskApiProps {
  defaultTaskId?: string;
  defaultTitle?: string;
  defaultDescription?: string;
  defaultType?: string;
  defaultStatus?: string;
  defaultStage?: string;
  defaultPriority?: string;
  defaultScheduledDate?: string;
  defaultAmount?: number;
  defaultAssignee?: string;
  defaultNotes?: string;
  defaultAddress?: string;
  defaultCompletedDate?: string;
}

export interface UpdateTaskApiState {
  task_id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  stage: string;
  priority: string;
  scheduled_date: string;
  amount: string;
  assignee: string;
  notes: string;
  address: string;
  completed_date: string;
}

// Configuración de la API de UpdateTask
const UpdateTaskApi: BaseApiConfig = {
  id: 'update-task',
  name: 'Update Task API',
  description: 'API para actualizar tareas existentes en el sistema',
  defaultEndpoint: '/api/agents/tools/tasks/update',

  // Obtener el estado inicial
  getInitialState: (props: UpdateTaskApiProps): UpdateTaskApiState => {
    return {
      task_id: props.defaultTaskId || 'abcdef12-3456-7890-abcd-ef1234567890',
      title: props.defaultTitle || 'Seguimiento de lead actualizado',
      description: props.defaultDescription || 'Actualizar información del cliente y programar próxima reunión',
      type: props.defaultType || 'follow_up',
      status: props.defaultStatus || 'in_progress',
      stage: props.defaultStage || 'consideration',
      priority: props.defaultPriority || 'high',
      scheduled_date: props.defaultScheduledDate || '2024-01-25T15:00:00Z',
      amount: props.defaultAmount?.toString() || '2500.00',
      assignee: props.defaultAssignee || '',
      notes: props.defaultNotes || 'Cliente muy interesado, requiere demo técnico especializado',
      completed_date: props.defaultCompletedDate || '',
      address: props.defaultAddress || JSON.stringify({
        "venue_name": "Oficina del cliente",
        "street": "Av. Reforma 456",
        "floor": "Piso 12",
        "suite": "Suite 1201",
        "city": "Ciudad de México",
        "state": "CDMX",
        "postal_code": "06600",
        "country": "México",
        "parking_instructions": "Estacionamiento disponible en el sótano",
        "access_code": "1234"
      }, null, 2)
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: UpdateTaskApiState): Record<string, any> => {
    const payload: any = {
      task_id: state.task_id
    };

    // Solo incluir campos que tienen valores (actualización parcial)
    if (state.title.trim()) payload.title = state.title.trim();
    if (state.description.trim()) payload.description = state.description.trim();
    if (state.type) payload.type = state.type;
    if (state.status) payload.status = state.status;
    if (state.stage) payload.stage = state.stage;
    if (state.scheduled_date) payload.scheduled_date = state.scheduled_date;
    if (state.completed_date) payload.completed_date = state.completed_date;
    if (state.amount && !isNaN(parseFloat(state.amount))) {
      payload.amount = parseFloat(state.amount);
    }
    if (state.assignee.trim()) payload.assignee = state.assignee.trim();
    if (state.notes.trim()) payload.notes = state.notes.trim();

    // Prioridad especial
    if (state.priority) {
      const priorityMap: Record<string, number> = {
        low: 2,
        medium: 5,
        high: 10,
        urgent: 15
      };
      payload.priority = priorityMap[state.priority] || parseInt(state.priority);
    }

    // Address JSON
    if (state.address.trim()) {
      try {
        payload.address = JSON.parse(state.address);
      } catch (e) {
        // Si no es JSON válido, guardarlo como string
        payload.address = { note: state.address };
      }
    }

    return payload;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: UpdateTaskApiState;
    setState: React.Dispatch<React.SetStateAction<UpdateTaskApiState>>;
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof UpdateTaskApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };

    const statusOptions = [
      { value: '', label: 'Sin cambio' },
      { value: 'pending', label: 'Pendiente' },
      { value: 'in_progress', label: 'En Progreso' },
      { value: 'completed', label: 'Completada' },
      { value: 'failed', label: 'Fallida' }
    ];

    const stageOptions = [
      { value: '', label: 'Sin cambio' },
      { value: 'awareness', label: 'Conciencia' },
      { value: 'consideration', label: 'Consideración' },
      { value: 'decision', label: 'Decisión' },
      { value: 'purchase', label: 'Compra' },
      { value: 'retention', label: 'Retención' },
      { value: 'referral', label: 'Referencia' },
      { value: 'completed', label: 'Completado' }
    ];

    const priorityOptions = [
      { value: '', label: 'Sin cambio' },
      { value: 'low', label: 'Baja (0-3)' },
      { value: 'medium', label: 'Media (4-7)' },
      { value: 'high', label: 'Alta (8-12)' },
      { value: 'urgent', label: 'Urgente (13+)' }
    ];

    const typeOptions = [
      { value: '', label: 'Sin cambio' },
      { value: 'call', label: 'Llamada' },
      { value: 'email', label: 'Email' },
      { value: 'meeting', label: 'Reunión' },
      { value: 'demo', label: 'Demostración' },
      { value: 'follow_up', label: 'Seguimiento' },
      { value: 'quote', label: 'Cotización' },
      { value: 'contract', label: 'Contrato' },
      { value: 'payment', label: 'Pago' },
      { value: 'support', label: 'Soporte' },
      { value: 'custom', label: 'Personalizado' }
    ];

    return (
      <>
        <SectionLabel>Información Requerida</SectionLabel>
        
        <FormField
          label="Task ID (Requerido) *"
          id="task_id"
          type="text"
          value={state.task_id}
          onChange={(value) => handleChange('task_id', value)}
          placeholder="UUID de la tarea a actualizar"
          required
        />

        <SectionLabel>Campos a Actualizar (Opcional)</SectionLabel>

        <FormField
          label="Título"
          id="title"
          type="text"
          value={state.title}
          onChange={(value) => handleChange('title', value)}
          placeholder="Nuevo título de la tarea"
        />

        <FormField
          label="Tipo de Tarea"
          id="type"
          type="select"
          value={state.type}
          onChange={(value) => handleChange('type', value)}
          options={typeOptions}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            label="Estado"
            id="status"
            type="select"
            value={state.status}
            onChange={(value) => handleChange('status', value)}
            options={statusOptions}
          />

          <FormField
            label="Etapa"
            id="stage"
            type="select"
            value={state.stage}
            onChange={(value) => handleChange('stage', value)}
            options={stageOptions}
          />
        </div>

        <FormField
          label="Prioridad"
          id="priority"
          type="select"
          value={state.priority}
          onChange={(value) => handleChange('priority', value)}
          options={priorityOptions}
        />

        <SectionLabel>Fechas y Programación</SectionLabel>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            label="Fecha Programada"
            id="scheduled_date"
            type="text"
            value={state.scheduled_date}
            onChange={(value) => handleChange('scheduled_date', value)}
            placeholder="2024-01-25T15:00:00Z"
          />

          <FormField
            label="Fecha de Completado"
            id="completed_date"
            type="text"
            value={state.completed_date}
            onChange={(value) => handleChange('completed_date', value)}
            placeholder="2024-01-25T16:30:00Z"
          />
        </div>

        <SectionLabel>Asignación y Monto</SectionLabel>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            label="Monto"
            id="amount"
            type="number"
            value={state.amount}
            onChange={(value) => handleChange('amount', value)}
            placeholder="0.00"
          />

          <FormField
            label="Asignar a (UUID)"
            id="assignee"
            type="text"
            value={state.assignee}
            onChange={(value) => handleChange('assignee', value)}
            placeholder="UUID del usuario asignado"
          />
        </div>

        <SectionLabel>Información Adicional</SectionLabel>

        <FormField
          label="Descripción"
          id="description"
          type="textarea"
          value={state.description}
          onChange={(value) => handleChange('description', value)}
          placeholder="Nueva descripción detallada de la tarea"
          rows={3}
        />

        <FormField
          label="Notas"
          id="notes"
          type="textarea"
          value={state.notes}
          onChange={(value) => handleChange('notes', value)}
          placeholder="Notas adicionales sobre la actualización"
          rows={3}
        />

        <FormField
          label="Dirección (JSON)"
          id="address"
          type="textarea"
          value={state.address}
          onChange={(value) => handleChange('address', value)}
          placeholder="Información de dirección en formato JSON"
          rows={8}
        />
      </>
    );
  }
};

export default UpdateTaskApi; 