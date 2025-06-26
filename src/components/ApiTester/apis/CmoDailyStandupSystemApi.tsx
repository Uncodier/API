'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField } from '../components/FormComponents';

// Props específicas para el API de CMO Daily StandUp System
export interface CmoDailyStandupSystemApiProps {
  defaultEndpoint?: string;
}

// Estado específico para el API de CMO Daily StandUp System
export interface CmoDailyStandupSystemApiState {
  site_id: string;
  command_id?: string;
}

// Configuración de la API de CMO Daily StandUp System
const CmoDailyStandupSystemApi: BaseApiConfig = {
  id: 'cmo-daily-standup-system',
  name: 'API de CMO Daily StandUp System Analysis',
  description: 'API para generar análisis estratégicos del estado del sistema para reuniones diarias de seguimiento',
  defaultEndpoint: '/api/agents/cmo/dailyStandUp/system',

  // Obtener el estado inicial
  getInitialState: (props: CmoDailyStandupSystemApiProps): CmoDailyStandupSystemApiState => {
    return {
      site_id: '3ea5c0b8-d6eb-403d-9acb-03128d65d1a2', // UUID de ejemplo
      command_id: ''
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: CmoDailyStandupSystemApiState): Record<string, any> => {
    const body: Record<string, any> = {
      site_id: state.site_id
    };
    
    if (state.command_id && state.command_id.trim()) {
      body.command_id = state.command_id.trim();
    }
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: CmoDailyStandupSystemApiState;
    setState: React.Dispatch<React.SetStateAction<CmoDailyStandupSystemApiState>>;
  }) => {
    const { state, setState } = props;
    
    // Función para manejar cambios en los campos
    const handleChange = (field: string, value: any) => {
      setState((prev: any) => ({
        ...prev,
        [field]: value
      }));
    };

    // Función para validar UUID
    const isValidUUID = (uuid: string): boolean => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      return uuidRegex.test(uuid);
    };

    return (
      <>
        <FormField
          label="Site ID (UUID requerido)"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value: any) => handleChange('site_id', value)}
          placeholder="3ea5c0b8-d6eb-403d-9acb-03128d65d1a2"
          required
        />
        
        <div className="text-sm text-gray-600 mb-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex items-start space-x-2">
            <div className="text-blue-500 mt-0.5">ℹ️</div>
            <div>
              <strong>Validación UUID:</strong> 
              {state.site_id ? (
                isValidUUID(state.site_id) ? (
                  <span className="text-green-600 ml-2">✅ UUID válido</span>
                ) : (
                  <span className="text-red-600 ml-2">❌ UUID inválido</span>
                )
              ) : (
                <span className="text-gray-500 ml-2">⏳ Ingrese un UUID</span>
              )}
            </div>
          </div>
        </div>
        
        <FormField
          label="Command ID (opcional)"
          id="command_id"
          type="text"
          value={state.command_id || ''}
          onChange={(value: any) => handleChange('command_id', value)}
          placeholder="cmd_12345"
        />
        
        <div className="text-sm text-gray-600 mb-4 p-3 bg-yellow-50 rounded-lg border border-yellow-200">
          <div className="flex items-start space-x-2">
            <div className="text-yellow-600 mt-0.5">⚠️</div>
            <div>
              <strong>Nota importante:</strong> Esta API requiere que exista un agente CMO activo 
              (role: 'Growth Lead/Manager', status: 'active') para el site_id proporcionado. 
              Si no existe, recibirás un error 404.
            </div>
          </div>
        </div>
        
        <div className="text-sm text-gray-600 mb-4 p-3 bg-green-50 rounded-lg border border-green-200">
          <div className="flex items-start space-x-2">
            <div className="text-green-600 mt-0.5">📊</div>
            <div>
              <strong>Datos analizados:</strong>
              <ul className="mt-2 space-y-1 text-xs">
                <li>• Configuración del sitio y estado actual</li>
                <li>• Información de facturación y suscripciones</li>
                <li>• Métricas de actividad (últimas 24 horas)</li>
                <li>• Settings y configuraciones del sitio</li>
              </ul>
            </div>
          </div>
        </div>
        
        <div className="text-sm text-gray-600 mb-4 p-3 bg-purple-50 rounded-lg border border-purple-200">
          <div className="flex items-start space-x-2">
            <div className="text-purple-600 mt-0.5">🎯</div>
            <div>
              <strong>Análisis estratégico incluye:</strong>
              <ul className="mt-2 space-y-1 text-xs">
                <li>• Evaluación de salud del sistema (Verde/Amarillo/Rojo)</li>
                <li>• Revisión estratégica de facturación</li>
                <li>• Análisis de configuración y setup</li>
                <li>• Estado de onboarding y activación</li>
                <li>• Recomendaciones de acción estratégica</li>
                <li>• Evaluación de riesgos y oportunidades</li>
              </ul>
            </div>
          </div>
        </div>
      </>
    );
  },


};

export default CmoDailyStandupSystemApi; 