'use client';

import React from 'react';
import { BaseApiConfig, ApiType } from '../types';
import { FormField } from '../components/FormComponents';
import styles from '../../ApiTester.module.css';

const EmailOptimizedApi: BaseApiConfig = {
  id: 'email_agent' as ApiType,
  name: 'Email Analysis API (Optimized) ✨',
  description: 'API para análisis de emails con optimización de texto avanzada',
  defaultEndpoint: '/api/agents/email',

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

  renderFields: ({ state, setState }: any) => (
    <div className="space-y-4">
      {/* Información de optimización */}
      <div className={styles.callout}>
        <div className={styles.calloutIcon}>⚡</div>
        <div className={styles.calloutContent}>
          <p>
            <span className={styles.calloutText}>Optimización Activa:</span>
            Los emails serán procesados automáticamente para eliminar contenido innecesario 
            (firmas, disclaimers, texto citado) y reducir el uso de tokens significativamente.
          </p>
        </div>
      </div>

      <FormField
        label="Site ID"
        id="site_id"
        type="text"
        value={state.site_id}
        onChange={(value: string) => setState({ site_id: value })}
        placeholder="f87bdc7f-0efe-4aa5-b499-49d85be4b154"
        required
      />

      <FormField
        label="Límite de emails"
        id="limit"
        type="number"
        value={state.limit}
        onChange={(value: string) => setState({ limit: parseInt(value) || 10 })}
        placeholder="10"
        min={1}
        max={100}
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
              const isoDate = new Date(value + 'T00:00:00Z').toISOString();
              setState({ since_date: isoDate });
            } else {
              setState({ since_date: undefined });
            }
          }}
          className={styles.formControl}
          placeholder="Selecciona una fecha"
        />
        <small style={{ color: 'var(--nextra-secondary-text-color, #6c757d)', fontSize: '0.875rem', marginTop: '0.25rem', display: 'block' }}>
          Solo se analizarán emails recibidos después de esta fecha
        </small>
      </div>

      <FormField
        label="Agent ID (opcional)"
        id="agentId"
        type="text"
        value={state.agentId}
        onChange={(value: string) => setState({ agentId: value })}
        placeholder="478d3106-7391-4d9a-a5c1-8466202b45a9"
      />

      <FormField
        label="Tipo de análisis (opcional)"
        id="analysis_type"
        type="select"
        value={state.analysis_type}
        onChange={(value: string) => setState({ analysis_type: value })}
        options={[
          { value: '', label: 'Análisis estándar' },
          { value: 'commercial', label: 'Enfoque comercial' },
          { value: 'support', label: 'Enfoque de soporte' },
          { value: 'lead_qualification', label: 'Calificación de leads' }
        ]}
      />

      {/* Campos opcionales colapsables */}
      <details className={styles.formGroup}>
        <summary style={{ cursor: 'pointer', fontWeight: '500', marginBottom: '0.5rem' }}>
          Parámetros Avanzados (Opcional)
        </summary>
        
        <div style={{ paddingLeft: '1rem', borderLeft: '2px solid var(--nextra-border-color, #dee2e6)' }}>
          <FormField
            label="Lead ID"
            id="lead_id"
            type="text"
            value={state.lead_id}
            onChange={(value: string) => setState({ lead_id: value })}
            placeholder="ID del lead específico"
          />

          <FormField
            label="User ID"
            id="user_id"
            type="text"
            value={state.user_id}
            onChange={(value: string) => setState({ user_id: value })}
            placeholder="ID del usuario"
          />

          <FormField
            label="Team Member ID"
            id="team_member_id"
            type="text"
            value={state.team_member_id}
            onChange={(value: string) => setState({ team_member_id: value })}
            placeholder="ID del miembro del equipo"
          />
        </div>
      </details>

      {/* Información adicional sobre optimización */}
      <div style={{ 
        background: 'var(--nextra-callout-bg, rgba(13, 110, 253, 0.05))', 
        padding: '1rem', 
        borderRadius: '6px',
        border: '1px solid rgba(13, 110, 253, 0.2)'
      }}>
        <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.9rem', fontWeight: '600' }}>
          💡 Optimizaciones Aplicadas Automáticamente:
        </h4>
        <ul style={{ margin: '0', paddingLeft: '1.25rem', fontSize: '0.875rem', lineHeight: '1.4' }}>
          <li>Eliminación de firmas y disclaimers legales</li>
          <li>Remoción de texto citado en respuestas</li>
          <li>Limpieza de headers innecesarios</li>
          <li>Límite de 2000 caracteres por email</li>
          <li>Métricas de compresión en la respuesta</li>
        </ul>
      </div>
    </div>
  ),
};

export default EmailOptimizedApi; 