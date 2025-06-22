'use client';

import React from 'react';
import { BaseApiConfig, ApiType } from '../types';
import { FormField } from '../components/FormComponents';
import styles from '../../ApiTester.module.css';

const DataAnalystLeadSegmentationApi: BaseApiConfig = {
  id: 'data-analyst-lead-segmentation' as ApiType,
  name: 'Data Analyst Lead Segmentation API',
  description: 'API para segmentación automática de leads usando el agente Data Analyst',
  defaultEndpoint: '/api/agents/dataAnalyst/leadSegmentation',

  getInitialState: () => ({
    lead_id: '',
    site_id: '',
    auto_assign: true,
  }),

  buildRequestBody: (state: any) => ({
    lead_id: state.lead_id,
    site_id: state.site_id,
    auto_assign: state.auto_assign !== undefined ? state.auto_assign : true,
  }),

  renderFields: ({ state, setState }: any) => (
    <div className="space-y-4">
      {/* Campos requeridos */}
      <FormField
        label="Lead ID"
        id="lead_id"
        type="text"
        value={state.lead_id}
        onChange={(value: string) => setState({ lead_id: value })}
        placeholder="UUID del lead a segmentar"
        required
      />

      <FormField
        label="Site ID"
        id="site_id"
        type="text"
        value={state.site_id}
        onChange={(value: string) => setState({ site_id: value })}
        placeholder="UUID del sitio"
        required
      />

      {/* Opciones */}
      <div className={styles.formGroup}>
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            id="auto_assign"
            checked={state.auto_assign}
            onChange={(e) => setState({ auto_assign: e.target.checked })}
            className="rounded"
          />
          <span className="text-sm font-medium">Asignar automáticamente el segmento recomendado</span>
        </label>
      </div>

      {/* Información adicional */}
      <div className={styles.helpText}>
        <h4 className="font-medium text-sm mb-2">Información:</h4>
        <ul className="text-xs space-y-1">
          <li>• <strong>Lead ID</strong> y <strong>Site ID</strong> son requeridos (formato UUID)</li>
          <li>• El sistema analizará el lead contra todos los segmentos del sitio</li>
          <li>• Si <strong>auto_assign</strong> está habilitado, el lead se asignará automáticamente al segmento recomendado</li>
          <li>• La respuesta incluirá análisis detallado de coincidencias y puntuaciones de ajuste</li>
          <li>• Se consideran factores como demografía, comportamiento, idioma y valor</li>
        </ul>
      </div>
    </div>
  )
};

export default DataAnalystLeadSegmentationApi; 