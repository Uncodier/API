import React from 'react';
import { BaseApiConfig, ApiType } from '../types';
import { FormField } from '../components/FormComponents';
import { v4 as generateUUID } from 'uuid';

// Tipos para la API de Identificación de Visitantes
interface VisitorIdentifyApiProps {
  defaultEndpoint?: string;
  defaultMethod?: 'POST';
  defaultSiteId?: string;
  defaultVisitorId?: string;
  defaultLeadId?: string;
  defaultTraits?: string;
  defaultTimestamp?: number;
}

interface VisitorIdentifyApiState {
  endpoint: string;
  method: 'POST';
  site_id: string;
  visitor_id: string;
  lead_id: string;
  segment_id: string;
  traits: string;
  timestamp: number;
}

// Tipo para el valor del manejador de cambios
type FieldValue = string | number | boolean;

// Configuración de la API de Identificación de Visitantes
const VisitorIdentifyApi: BaseApiConfig = {
  id: 'visitor_identify' as ApiType,
  name: 'API de Identificación de Visitantes',
  description: 'API para vincular visitantes anónimos con información de identificación conocida',
  defaultEndpoint: '/api/visitors/identify',

  // Obtener el estado inicial
  getInitialState: (props: VisitorIdentifyApiProps): VisitorIdentifyApiState => {
    // Generar IDs por defecto si no se proporcionan
    const defaultSiteId = props.defaultSiteId || generateUUID();
    const defaultVisitorId = props.defaultVisitorId || generateUUID();
    const defaultLeadId = props.defaultLeadId || generateUUID();
    
    return {
      endpoint: props.defaultEndpoint || '/api/visitors/identify',
      method: props.defaultMethod || 'POST',
      site_id: defaultSiteId,
      visitor_id: defaultVisitorId,
      lead_id: defaultLeadId,
      segment_id: '',
      traits: props.defaultTraits || JSON.stringify({
        email: 'usuario@ejemplo.com',
        name: 'Ana García',
        company: {
          name: 'Empresa Innovadora SL',
          role: 'Marketing Manager'
        }
      }, null, 2),
      timestamp: props.defaultTimestamp || Date.now()
    };
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: VisitorIdentifyApiState;
    setState: React.Dispatch<React.SetStateAction<VisitorIdentifyApiState>>;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    // Función para manejar los cambios en los campos del formulario
    const handleChange = (field: keyof VisitorIdentifyApiState, value: FieldValue) => {
      setState(prevState => ({ ...prevState, [field]: value }));
    };
    
    return (
      <>
        <FormField
          label="Endpoint"
          id="endpoint"
          type="text"
          value={state.endpoint}
          onChange={(value: string) => handleChange('endpoint', value)}
          placeholder="/api/visitors/identify"
          required
        />
        
        <FormField
          label="ID del Sitio"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value: string) => handleChange('site_id', value)}
          placeholder="site_123abc"
          required
        />
        
        <FormField
          label="ID del Visitante"
          id="visitor_id"
          type="text"
          value={state.visitor_id}
          onChange={(value: string) => handleChange('visitor_id', value)}
          placeholder="vis_abcd1234"
          required
        />
        
        <FormField
          label="ID del Lead"
          id="lead_id"
          type="text"
          value={state.lead_id}
          onChange={(value: string) => handleChange('lead_id', value)}
          placeholder="lead_xyz789"
        />

        <FormField
          label="ID del Segmento"
          id="segment_id"
          type="text"
          value={state.segment_id}
          onChange={(value: string) => handleChange('segment_id', value)}
          placeholder="seg_xyz789"
        />
        
        <FormField
          label="Traits (JSON)"
          id="traits"
          type="textarea"
          value={state.traits}
          onChange={(value: string) => handleChange('traits', value)}
          placeholder='{"email": "usuario@ejemplo.com"}'
          rows={10}
        />
        
        <FormField
          label="Timestamp"
          id="timestamp"
          type="number"
          value={state.timestamp}
          onChange={(value: number) => handleChange('timestamp', value)}
          placeholder={Date.now().toString()}
        />
      </>
    );
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: VisitorIdentifyApiState): Record<string, any> => {
    const body: Record<string, any> = {
      site_id: state.site_id,
      visitor_id: state.visitor_id,
      lead_id: state.lead_id
    };

    if (state.segment_id) {
      body.segment_id = state.segment_id;
    }

    if (state.traits) {
      try {
        body.traits = JSON.parse(state.traits);
      } catch (e) {
        console.error('Error parsing traits JSON:', e);
      }
    }

    if (state.timestamp) {
      body.timestamp = state.timestamp;
    }

    return body;
  }
};

export default VisitorIdentifyApi; 