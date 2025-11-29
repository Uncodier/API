'use client';

import React from 'react';
import { BaseApiConfig, ApiType } from '../types';
import { FormField } from '../components/FormComponents';
import styles from '../../ApiTester.module.css';

const DataAnalystAnalysisApi: BaseApiConfig = {
  id: 'data-analyst-analysis' as ApiType,
  name: 'Data Analyst Analysis API',
  description: 'API para análisis de datos de investigación usando el agente Data Analyst',
  defaultEndpoint: '/api/agents/dataAnalyst/analysis',

  getInitialState: () => ({
    site_id: '',
    agent_id: '',
    command_id: '',
    data: '',
    analysis_type: 'comprehensive',
    time_range_from: '',
    time_range_to: '',
    memory_limit: 50,
    include_raw_data: false,
    deliverables: '',
  }),

  buildRequestBody: (state: any) => {
    const body: any = {
      site_id: state.site_id,
      analysis_type: state.analysis_type || 'comprehensive',
      memory_limit: parseInt(state.memory_limit) || 50,
      include_raw_data: state.include_raw_data || false,
    };

    // Agregar campos opcionales solo si tienen valor
    if (state.agent_id) body.agent_id = state.agent_id;
    if (state.command_id) body.command_id = state.command_id;
    if (state.data) {
      try {
        // Intentar parsear como JSON, si falla usar como string
        body.data = JSON.parse(state.data);
      } catch {
        body.data = state.data;
      }
    }

    // Agregar time_range si se proporcionan fechas
    if (state.time_range_from || state.time_range_to) {
      body.time_range = {};
      if (state.time_range_from) {
        body.time_range.from = new Date(state.time_range_from).toISOString();
      }
      if (state.time_range_to) {
        body.time_range.to = new Date(state.time_range_to).toISOString();
      }
    }

    // Agregar deliverables si se proporciona
    if (state.deliverables) {
      try {
        body.deliverables = JSON.parse(state.deliverables);
      } catch {
        // Si no es JSON válido, crear un objeto simple
        body.deliverables = { custom: state.deliverables };
      }
    }

    return body;
  },

  renderFields: ({ state, setState, control }: any) => (
    <div className="space-y-4">
      {/* Campo requerido */}
      <FormField
        label="Site ID"
        id="site_id"
        type="text"
        value={state.site_id}
        onChange={(value: string) => setState({ site_id: value })}
        placeholder="ID del sitio (UUID)"
        required
      />

      {/* Campos opcionales */}
      <FormField
        label="Agent ID (opcional)"
        id="agent_id"
        type="text"
        value={state.agent_id}
        onChange={(value: string) => setState({ agent_id: value })}
        placeholder="ID específico del agente Data Analyst"
      />

      <FormField
        label="Command ID (opcional)"
        id="command_id"
        type="text"
        value={state.command_id}
        onChange={(value: string) => setState({ command_id: value })}
        placeholder="ID del comando para filtrar memorias"
      />

      <FormField
        label="Tipo de análisis"
        id="analysis_type"
        type="select"
        value={state.analysis_type}
        onChange={(value: string) => setState({ analysis_type: value })}
        options={[
          { value: 'comprehensive', label: 'Comprensivo' },
          { value: 'market_analysis', label: 'Análisis de mercado' },
          { value: 'competitive', label: 'Análisis competitivo' },
          { value: 'lead_research', label: 'Investigación de leads' },
          { value: 'trend_analysis', label: 'Análisis de tendencias' },
          { value: 'strategic', label: 'Análisis estratégico' }
        ]}
      />

      <div className={styles.formGroup}>
        <label className="block text-sm font-medium mb-1">Límite de memorias</label>
        <input
          type="number"
          id="memory_limit"
          value={state.memory_limit}
          onChange={(e) => setState({ memory_limit: parseInt(e.target.value) || 50 })}
          className={styles.formControl}
          placeholder="50"
          min="1"
          max="500"
        />
      </div>

      {/* Rango de tiempo */}
      <div className={styles.formGroup}>
        <label className="block text-sm font-medium mb-1">Fecha desde (opcional)</label>
        <input
          type="datetime-local"
          id="time_range_from"
          value={state.time_range_from}
          onChange={(e) => setState({ time_range_from: e.target.value })}
          className={styles.formControl}
        />
      </div>

      <div className={styles.formGroup}>
        <label className="block text-sm font-medium mb-1">Fecha hasta (opcional)</label>
        <input
          type="datetime-local"
          id="time_range_to"
          value={state.time_range_to}
          onChange={(e) => setState({ time_range_to: e.target.value })}
          className={styles.formControl}
        />
      </div>

      {/* Datos adicionales */}
      <div className={styles.formGroup}>
        <label className="block text-sm font-medium mb-1">Datos adicionales (opcional)</label>
        <textarea
          id="data"
          value={state.data}
          onChange={(e) => setState({ data: e.target.value })}
          className={styles.formControl}
          placeholder='Datos adicionales como texto o JSON: {"context": "información adicional"}'
          rows={4}
        />
      </div>

      {/* Deliverables */}
      <div className={styles.formGroup}>
        <label className="block text-sm font-medium mb-1">Deliverables (opcional - JSON)</label>
        <textarea
          id="deliverables"
          value={state.deliverables}
          onChange={(e) => setState({ deliverables: e.target.value })}
          className={styles.formControl}
          placeholder='{"market_analysis": "object", "competitor_insights": "array"}'
          rows={3}
        />
      </div>

      {/* Incluir datos raw */}
      <div className={styles.formGroup}>
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            id="include_raw_data"
            checked={state.include_raw_data}
            onChange={(e) => setState({ include_raw_data: e.target.checked })}
            className="rounded"
          />
          <span className="text-sm font-medium">Incluir datos raw en la respuesta</span>
        </label>
      </div>

      {/* Información adicional */}
      <div className={styles.helpText}>
        <h4 className="font-medium text-sm mb-2">Información:</h4>
        <ul className="text-xs space-y-1">
          <li>• <strong>Site ID</strong> es requerido (formato UUID)</li>
          <li>• <strong>Command ID</strong> puede ser UUID o original_command_id</li>
          <li>• <strong>Datos adicionales</strong> pueden ser texto plano o JSON</li>
          <li>• <strong>Deliverables</strong> define la estructura de salida personalizada</li>
          <li>• El análisis consolida memorias de búsqueda y datos adicionales</li>
          <li>• El resultado incluye insights, recomendaciones y conclusiones</li>
        </ul>
      </div>
    </div>
  ),
};

export default DataAnalystAnalysisApi; 