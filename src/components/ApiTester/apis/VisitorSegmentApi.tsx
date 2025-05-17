'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField } from '../components/FormComponents';

// Estado específico para la API de Segmentación de Visitantes
export interface VisitorSegmentApiState {
  site_id: string;
  url: string;
  visitor_id: string;
  segment_id?: string;
  s?: string;
  name?: string;
  n?: string;
  lead_id?: string;
  rules?: any[];
  method: 'POST';
}

// Props específicas para la API de Segmentación de Visitantes
export interface VisitorSegmentApiProps {
  defaultEndpoint?: string;
}

// Configuración de la API de Segmentación de Visitantes
const VisitorSegmentApi: BaseApiConfig = {
  id: 'visitor_segment',
  name: 'API de Segmentación de Visitantes',
  description: 'Asigna segmentos a visitantes y leads basados en la URL y reglas definidas.',
  defaultEndpoint: '/api/visitors/segment',

  // Obtener el estado inicial
  getInitialState: (props: VisitorSegmentApiProps): VisitorSegmentApiState => {
    return {
      site_id: 'site_test_123',
      url: 'https://ejemplo.com/productos',
      visitor_id: 'vis_test_123',
      segment_id: '',
      s: '',
      name: '',
      n: '',
      lead_id: '',
      rules: [{
        field: "page.url",
        operator: "contains",
        value: "/productos",
        type: "page"
      }],
      method: 'POST'
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: VisitorSegmentApiState): Record<string, any> => {
    const body: Record<string, any> = {
      site_id: state.site_id,
      url: state.url,
      visitor_id: state.visitor_id
    };

    // Usar el primer valor no vacío entre segment_id y s
    const segmentId = state.segment_id || state.s;
    if (segmentId) body.segment_id = segmentId;

    // Usar el primer valor no vacío entre name y n
    const segmentName = state.name || state.n;
    if (segmentName) body.name = segmentName;

    if (state.lead_id) body.lead_id = state.lead_id;
    if (state.rules && state.rules.length > 0) body.rules = state.rules;

    return body;
  },

  // Construir las cabeceras de la solicitud
  buildRequestHeaders: (state: VisitorSegmentApiState): Record<string, string> => {
    return {
      'Content-Type': 'application/json',
      'X-SA-API-KEY': 'tu-api-key'
    };
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: VisitorSegmentApiState;
    setState: React.Dispatch<React.SetStateAction<VisitorSegmentApiState>>;
  }) => {
    const { state, setState } = props;

    const handleChange = (field: keyof VisitorSegmentApiState, value: any) => {
      setState(prev => {
        const newState = { ...prev, [field]: value };
        
        // Sincronizar campos alternativos
        if (field === 'segment_id') newState.s = value;
        if (field === 's') newState.segment_id = value;
        if (field === 'name') newState.n = value;
        if (field === 'n') newState.name = value;
        
        return newState;
      });
    };

    return (
      <>
        <FormField
          label="ID del Sitio"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value) => handleChange('site_id', value)}
          placeholder="site_test_123"
          required
        />

        <FormField
          label="URL a analizar"
          id="url"
          type="text"
          value={state.url}
          onChange={(value) => handleChange('url', value)}
          placeholder="https://tusitio.com/pagina"
          required
        />

        <FormField
          label="ID del Visitante"
          id="visitor_id"
          type="text"
          value={state.visitor_id}
          onChange={(value) => handleChange('visitor_id', value)}
          placeholder="vis_test_123"
          required
        />

        <FormField
          label="ID del Segmento (segment_id o s)"
          id="segment_id"
          type="text"
          value={state.segment_id}
          onChange={(value) => handleChange('segment_id', value)}
          placeholder="seg_test_123"
        />

        <FormField
          label="Nombre del Segmento (name o n)"
          id="name"
          type="text"
          value={state.name}
          onChange={(value) => handleChange('name', value)}
          placeholder="Visitantes de productos"
        />

        <FormField
          label="ID del Lead (opcional)"
          id="lead_id"
          type="text"
          value={state.lead_id}
          onChange={(value) => handleChange('lead_id', value)}
          placeholder="lead_test_123"
        />

        <FormField
          label="Reglas (opcional)"
          id="rules"
          type="textarea"
          value={JSON.stringify(state.rules || [], null, 2)}
          onChange={(value) => {
            try {
              handleChange('rules', JSON.parse(value));
            } catch (e) {
              // Si el JSON no es válido, no actualizamos el estado
            }
          }}
          placeholder="Array de reglas de segmentación en formato JSON"
        />
      </>
    );
  }
};

export default VisitorSegmentApi; 