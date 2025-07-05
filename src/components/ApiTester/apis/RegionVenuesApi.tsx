import React from 'react';
import { BaseApiConfig } from '../types';

interface FormFieldProps {
  label: string;
  id: string;
  type: string;
  value: any;
  onChange: (value: any) => void;
  placeholder?: string;
  required?: boolean;
  rows?: number;
  options?: Array<{value: string, label: string}>;
  readOnly?: boolean;
}

// Componente FormField simplificado
const FormField: React.FC<FormFieldProps> = ({ 
  label, 
  id, 
  type, 
  value, 
  onChange, 
  placeholder, 
  required,
  rows = 3,
  options = [],
  readOnly = false
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    onChange(e.target.value);
  };

  return (
    <div style={{ marginBottom: '16px' }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: '4px', fontWeight: 'medium' }}>
        {label} {required && <span style={{ color: 'red' }}>*</span>}
      </label>
      
      {type === 'textarea' ? (
        <textarea
          id={id}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          required={required}
          rows={rows}
          readOnly={readOnly}
          style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
        />
      ) : type === 'select' ? (
        <select
          id={id}
          value={value}
          onChange={handleChange}
          required={required}
          disabled={readOnly}
          style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          required={required}
          readOnly={readOnly}
          style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
        />
      )}
    </div>
  );
};

interface RegionVenuesApiStateProps {
  state: Record<string, any>;
  setState: (updatedFields: Record<string, any>) => void;
  showJsonOption?: boolean;
  showScreenshotOption?: boolean;
  showModelOptions?: boolean;
  showAnalysisTypeField?: boolean;
  showSiteUrlField?: boolean;
  showUrlField?: boolean;
  additionalFields?: any[];
}

interface ApiDefaults {
  defaultMethod?: string;
  defaultEndpoint?: string;
  [key: string]: any;
}

const RegionVenuesApi: BaseApiConfig = {
  id: 'sales-venues',
  name: 'Region Venues API',
  description: 'API para buscar venues en regiones específicas usando datos de OpenStreetMap',
  defaultEndpoint: '/api/agents/sales/regionVenues',

  getInitialState: (defaults: ApiDefaults) => {
    return {
      method: defaults.defaultMethod || 'GET',
      endpoint: defaults.defaultEndpoint || '/api/agents/sales/regionVenues',
      siteId: '',
      searchTerm: 'restaurant',
      city: '',
      region: '',
      maxVenues: 10,
      userId: '',
      priority: 'medium',
      targetAudience: '',
      eventInfo: '',
      contactPreferences: ''
    };
  },

  buildRequestBody: (state: Record<string, any>) => {
    if (state.method === 'GET') {
      // Para GET, construimos los parámetros de consulta
      return {};
    }
    
    // Para POST, construimos el cuerpo de la solicitud
    let requestBody: Record<string, any> = {
      siteId: state.siteId,
      searchTerm: state.searchTerm,
      city: state.city,
      region: state.region,
      maxVenues: Number(state.maxVenues)
    };

    // Añadir campos opcionales solo si tienen valor
    if (state.userId) requestBody.userId = state.userId;
    if (state.priority) requestBody.priority = state.priority;
    
    // Parsear objetos JSON si están presentes
    if (state.targetAudience) {
      try {
        requestBody.targetAudience = JSON.parse(state.targetAudience);
      } catch (e) {
        // Si no es JSON válido, usar como string
        requestBody.targetAudience = { description: state.targetAudience };
      }
    }
    
    if (state.eventInfo) {
      try {
        requestBody.eventInfo = JSON.parse(state.eventInfo);
      } catch (e) {
        requestBody.eventInfo = { description: state.eventInfo };
      }
    }
    
    if (state.contactPreferences) {
      try {
        requestBody.contactPreferences = JSON.parse(state.contactPreferences);
      } catch (e) {
        requestBody.contactPreferences = { method: state.contactPreferences };
      }
    }

    return requestBody;
  },

  buildRequestUrl: (state: Record<string, any>, endpoint: string) => {
    if (state.method === 'GET') {
      // Para GET, construimos la URL con parámetros de consulta
      const params = new URLSearchParams();
      params.append('siteId', state.siteId);
      params.append('searchTerm', state.searchTerm);
      params.append('city', state.city);
      params.append('region', state.region);
      params.append('maxVenues', state.maxVenues.toString());
      
      return `${endpoint}?${params.toString()}`;
    }
    
    // Para POST, usar endpoint normal
    return endpoint;
  },

  renderFields: ({ state, setState }: RegionVenuesApiStateProps) => {
    return (
      <>
        <FormField
          label="HTTP Method"
          id="method"
          type="select"
          value={state.method}
          onChange={(value) => setState({ method: value })}
          options={[
            { value: 'GET', label: 'GET - Direct Search' },
            { value: 'POST', label: 'POST - Search with Metadata' }
          ]}
          required
        />

        <FormField
          label="Site ID"
          id="siteId"
          type="text"
          value={state.siteId}
          onChange={(value) => setState({ siteId: value })}
          placeholder="ID del sitio web"
          required
        />

        <FormField
          label="Search Term"
          id="searchTerm"
          type="text"
          value={state.searchTerm}
          onChange={(value) => setState({ searchTerm: value })}
          placeholder="Tipo de venue a buscar (restaurant, hotel, gym, etc.)"
          required
        />

        <FormField
          label="City"
          id="city"
          type="text"
          value={state.city}
          onChange={(value) => setState({ city: value })}
          placeholder="Ciudad donde buscar"
          required
        />

        <FormField
          label="Region"
          id="region"
          type="text"
          value={state.region}
          onChange={(value) => setState({ region: value })}
          placeholder="Región/estado/país (ej: Madrid, Spain)"
          required
        />

        <FormField
          label="Max Venues"
          id="maxVenues"
          type="number"
          value={state.maxVenues}
          onChange={(value) => setState({ maxVenues: value })}
          placeholder="Número máximo de venues a retornar (1-50)"
        />

        {state.method === 'POST' && (
          <>
            <FormField
              label="User ID"
              id="userId"
              type="text"
              value={state.userId}
              onChange={(value) => setState({ userId: value })}
              placeholder="ID del usuario (opcional para POST)"
            />

            <FormField
              label="Priority"
              id="priority"
              type="select"
              value={state.priority}
              onChange={(value) => setState({ priority: value })}
              options={[
                { value: 'high', label: 'High' },
                { value: 'medium', label: 'Medium' },
                { value: 'low', label: 'Low' }
              ]}
            />

            <FormField
              label="Target Audience (JSON)"
              id="targetAudience"
              type="textarea"
              value={state.targetAudience}
              onChange={(value) => setState({ targetAudience: value })}
              placeholder='{"demographics": "Business professionals", "interests": ["fine dining"], "budget": "premium"}'
              rows={3}
            />

            <FormField
              label="Event Info (JSON)"
              id="eventInfo"
              type="textarea"
              value={state.eventInfo}
              onChange={(value) => setState({ eventInfo: value })}
              placeholder='{"eventType": "corporate dinner", "expectedAttendees": 25, "date": "2024-06-15"}'
              rows={3}
            />

            <FormField
              label="Contact Preferences (JSON)"
              id="contactPreferences"
              type="textarea"
              value={state.contactPreferences}
              onChange={(value) => setState({ contactPreferences: value })}
              placeholder='{"contactMethod": "email", "bestTimeToContact": "business_hours"}'
              rows={3}
            />
          </>
        )}

        <div style={{ marginTop: '16px', padding: '12px', backgroundColor: '#f8f9fa', borderRadius: '4px' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>💡 Ejemplos de búsqueda:</h4>
          <ul style={{ margin: '0', paddingLeft: '20px', fontSize: '13px' }}>
            <li><strong>Restaurantes:</strong> restaurant, cafe, bar, pub</li>
            <li><strong>Alojamiento:</strong> hotel, hostel, guesthouse</li>
            <li><strong>Entretenimiento:</strong> cinema, theatre, nightclub</li>
            <li><strong>Recreación:</strong> gym, sports_centre, swimming_pool</li>
            <li><strong>Compras:</strong> shop, mall, market, boutique</li>
            <li><strong>Eventos:</strong> conference_centre, event_venue</li>
          </ul>
        </div>

        <div style={{ marginTop: '12px', padding: '12px', backgroundColor: '#e8f5e8', borderRadius: '4px' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>🗺️ Fuente de datos:</h4>
          <p style={{ margin: '0', fontSize: '13px' }}>
            Esta API usa <strong>OpenStreetMap</strong> (Nominatim + Overpass API) para encontrar venues.
            Los datos incluyen información de contacto, amenidades y ubicación cuando están disponibles.
          </p>
        </div>
      </>
    );
  }
};

export default RegionVenuesApi; 