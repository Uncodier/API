'use client';

import React from 'react';
import { emailEndpoints } from './EmailApi';
import { FormField } from '../components/FormComponents';
import styles from '../../ApiTester.module.css';

const EmailAnalysisApi = {
  id: 'email-analysis',
  name: 'Email Analysis API',
  description: 'API para obtener y analizar emails',
  defaultEndpoint: '/api/agents/email',
  endpoints: emailEndpoints,

  getInitialState: () => ({
    site_id: '',
    limit: 10,
    since_date: undefined,
    lead_id: undefined,
    agentId: undefined,
    user_id: undefined,
    team_member_id: undefined,
    analysis_type: undefined,
  }),

  buildRequestBody: (state: any) => {
    const body: any = {
      site_id: state.site_id,
      limit: parseInt(state.limit) || 10,
    };

    // Agregar campos opcionales solo si tienen valor
    if (state.since_date) body.since_date = state.since_date;
    if (state.lead_id) body.lead_id = state.lead_id;
    if (state.agentId) body.agentId = state.agentId;
    if (state.user_id) body.user_id = state.user_id;
    if (state.team_member_id) body.team_member_id = state.team_member_id;
    if (state.analysis_type) body.analysis_type = state.analysis_type;

    return body;
  },

  renderFields: ({ state, setState, control }: any) => (
    <div className="space-y-4">
      <FormField
        label="Site ID"
        id="site_id"
        type="text"
        value={state.site_id}
        onChange={(value: string) => setState({ site_id: value })}
        placeholder="ID del sitio"
        required
      />

      <FormField
        label="Límite de emails"
        id="limit"
        type="number"
        value={state.limit}
        onChange={(value: string) => setState({ limit: parseInt(value) || 10 })}
        placeholder="10"
      />

      <div className={styles.formGroup}>
        <label className="block text-sm font-medium mb-1">Desde fecha (opcional)</label>
        <input
          type="date"
          id="since_date"
          value={state.since_date ? new Date(state.since_date).toISOString().split('T')[0] : ''}
          onChange={(e) => {
            const value = e.target.value;
            if (value) {
              // Convertir la fecha a ISO string con hora 00:00:00
              const isoDate = new Date(value + 'T00:00:00Z').toISOString();
              setState({ since_date: isoDate });
            } else {
              setState({ since_date: undefined });
            }
          }}
          className={styles.formControl}
          placeholder="Selecciona una fecha"
        />
      </div>

      <FormField
        label="Lead ID (opcional)"
        id="lead_id"
        type="text"
        value={state.lead_id}
        onChange={(value: string) => setState({ lead_id: value })}
        placeholder="ID del lead"
      />

      <FormField
        label="Agent ID (opcional)"
        id="agentId"
        type="text"
        value={state.agentId}
        onChange={(value: string) => setState({ agentId: value })}
        placeholder="ID del agente"
      />

      <FormField
        label="User ID (opcional)"
        id="user_id"
        type="text"
        value={state.user_id}
        onChange={(value: string) => setState({ user_id: value })}
        placeholder="ID del usuario"
      />

      <FormField
        label="Team Member ID (opcional)"
        id="team_member_id"
        type="text"
        value={state.team_member_id}
        onChange={(value: string) => setState({ team_member_id: value })}
        placeholder="ID del miembro del equipo"
      />

      <FormField
        label="Tipo de análisis (opcional)"
        id="analysis_type"
        type="select"
        value={state.analysis_type}
        onChange={(value: string) => setState({ analysis_type: value })}
        options={[
          { value: '', label: 'Seleccionar tipo' },
          { value: 'commercial', label: 'Comercial' },
          { value: 'support', label: 'Soporte' },
          { value: 'general', label: 'General' }
        ]}
      />
    </div>
  ),
};

export default EmailAnalysisApi; 