import { BaseApiConfig } from '../types';
import { FormField } from '../utils';
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
  traits: string;
  timestamp: number;
}

// Configuración de la API de Identificación de Visitantes
const VisitorIdentifyApi: BaseApiConfig = {
  id: 'visitor_identify',
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
  renderFields: ({ state, setState }) => (
    <>
      <FormField
        label="Site ID"
        id="site_id"
        type="text"
        value={state.site_id}
        onChange={(value: string) => setState({ site_id: value })}
        placeholder="UUID del sitio"
        required
      />

      <FormField
        label="Visitor ID"
        id="visitor_id"
        type="text"
        value={state.visitor_id}
        onChange={(value: string) => setState({ visitor_id: value })}
        placeholder="UUID del visitante"
        required
      />

      <FormField
        label="Lead ID"
        id="lead_id"
        type="text"
        value={state.lead_id}
        onChange={(value: string) => setState({ lead_id: value })}
        placeholder="UUID del lead (opcional)"
      />

      <FormField
        label="Traits"
        id="traits"
        type="textarea"
        value={state.traits}
        onChange={(value: string) => setState({ traits: value })}
        placeholder="JSON con los atributos del lead"
        required
        rows={10}
      />

      <FormField
        label="Timestamp"
        id="timestamp"
        type="number"
        value={state.timestamp}
        onChange={(value: number) => setState({ timestamp: value })}
        placeholder="Marca de tiempo en milisegundos"
      />
    </>
  ),

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: VisitorIdentifyApiState): Record<string, any> => {
    const body: Record<string, any> = {
      site_id: state.site_id,
      visitor_id: state.visitor_id,
      timestamp: state.timestamp
    };

    // Solo incluir lead_id si está presente
    if (state.lead_id) {
      body.lead_id = state.lead_id;
    }

    // Parsear y validar los traits
    try {
      const traits = JSON.parse(state.traits);
      if (Object.keys(traits).length > 0) {
        body.traits = traits;
      }
    } catch (error) {
      console.error('Error parsing traits:', error);
    }

    return body;
  }
};

export default VisitorIdentifyApi; 