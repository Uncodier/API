'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField } from '../components/FormComponents';

// Props específicas para el API de Copywriter
export interface CopywriterApiProps {
  defaultModel?: string;
  defaultModelType?: string;
  showModelOptions?: boolean;
}

// Estado específico para el API de Copywriter
export interface CopywriterApiState {
  contentId: string;
  siteId: string;
  segmentId?: string;
  campaignId?: string;
  userId?: string;
  agent_id?: string;
  quickAction?: string;
  styleControls?: {
    tone?: string;
    complexity?: string;
    creativity?: string;
    persuasiveness?: string;
    targetAudience?: string;
    engagement?: string;
    size?: string;
  };
  whatImGoodAt?: string;
  topicsImInterestedIn?: string;
  topicsToAvoid?: string;
  aiPrompt?: string;
}

// Configuración de la API de Copywriter
const CopywriterApi: BaseApiConfig = {
  id: 'copywriter',
  name: 'API de Copywriter',
  description: 'API para edición y mejora de contenido utilizando IA',
  defaultEndpoint: '/api/agents/copywriter/content-editor',

  // Obtener el estado inicial
  getInitialState: (props: CopywriterApiProps): CopywriterApiState => {
    return {
      contentId: '',
      siteId: '',
      segmentId: '',
      campaignId: '',
      userId: '',
      agent_id: '',
      quickAction: 'improve',
      styleControls: {
        tone: 'friendly',
        complexity: 'moderate',
        creativity: 'balanced',
        persuasiveness: 'balanced',
        targetAudience: 'mixed',
        engagement: 'balanced',
        size: 'medium'
      },
      whatImGoodAt: '',
      topicsImInterestedIn: '',
      topicsToAvoid: '',
      aiPrompt: 'Make this content more engaging and impactful'
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: CopywriterApiState): Record<string, any> => {
    const body: Record<string, any> = {
      contentId: state.contentId,
      siteId: state.siteId
    };
    
    if (state.segmentId) body.segmentId = state.segmentId;
    if (state.campaignId) body.campaignId = state.campaignId;
    if (state.userId) body.userId = state.userId;
    if (state.agent_id) body.agent_id = state.agent_id;
    if (state.quickAction) body.quickAction = state.quickAction;
    if (state.styleControls) body.styleControls = state.styleControls;
    if (state.whatImGoodAt) body.whatImGoodAt = state.whatImGoodAt;
    if (state.topicsImInterestedIn) body.topicsImInterestedIn = state.topicsImInterestedIn;
    if (state.topicsToAvoid) body.topicsToAvoid = state.topicsToAvoid;
    if (state.aiPrompt) body.aiPrompt = state.aiPrompt;
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: CopywriterApiState;
    setState: React.Dispatch<React.SetStateAction<CopywriterApiState>>;
    showModelOptions?: boolean;
  }) => {
    const { state, setState, showModelOptions } = props;
    
    // Función para manejar cambios en los campos
    const handleChange = (field: string, value: any) => {
      setState((prev: any) => ({
        ...prev,
        [field]: value
      }));
    };

    // Función para manejar cambios en los controles de estilo
    const handleStyleChange = (field: string, value: any) => {
      setState((prev: any) => ({
        ...prev,
        styleControls: {
          ...prev.styleControls,
          [field]: value
        }
      }));
    };
    
    return (
      <>
        <FormField
          label="ID del Contenido"
          id="contentId"
          type="text"
          value={state.contentId}
          onChange={(value: any) => handleChange('contentId', value)}
          placeholder="content_abc123"
          required
        />
        
        <FormField
          label="ID del Sitio"
          id="siteId"
          type="text"
          value={state.siteId}
          onChange={(value: any) => handleChange('siteId', value)}
          placeholder="site_456"
          required
        />
        
        <FormField
          label="ID del Segmento (opcional)"
          id="segmentId"
          type="text"
          value={state.segmentId}
          onChange={(value: any) => handleChange('segmentId', value)}
          placeholder="seg_789"
        />
        
        <FormField
          label="ID de la Campaña (opcional)"
          id="campaignId"
          type="text"
          value={state.campaignId}
          onChange={(value: any) => handleChange('campaignId', value)}
          placeholder="camp_123"
        />
        
        <FormField
          label="ID del Usuario (opcional)"
          id="userId"
          type="text"
          value={state.userId}
          onChange={(value: any) => handleChange('userId', value)}
          placeholder="user_789"
        />
        
        <FormField
          label="ID del Agente (opcional)"
          id="agent_id"
          type="text"
          value={state.agent_id}
          onChange={(value: any) => handleChange('agent_id', value)}
          placeholder="agent_copywriter_123"
        />
        
        <FormField
          label="Acción Rápida"
          id="quickAction"
          type="select"
          value={state.quickAction}
          onChange={(value: any) => handleChange('quickAction', value)}
          options={[
            { value: "improve", label: "Mejorar" },
            { value: "expand", label: "Expandir" },
            { value: "style", label: "Estilizar" },
            { value: "summarize", label: "Resumir" }
          ]}
        />
        
        <h4>Controles de Estilo</h4>
        
        <FormField
          label="Tono"
          id="tone"
          type="select"
          value={state.styleControls?.tone}
          onChange={(value: any) => handleStyleChange('tone', value)}
          options={[
            { value: "neutral", label: "Neutral 🙂" },
            { value: "friendly", label: "Amigable 😊" }
          ]}
        />
        
        <FormField
          label="Complejidad"
          id="complexity"
          type="select"
          value={state.styleControls?.complexity}
          onChange={(value: any) => handleStyleChange('complexity', value)}
          options={[
            { value: "simple", label: "Simple 📝" },
            { value: "moderate", label: "Moderada 📘" },
            { value: "advanced", label: "Avanzada 📚" }
          ]}
        />
        
        <FormField
          label="Creatividad"
          id="creativity"
          type="select"
          value={state.styleControls?.creativity}
          onChange={(value: any) => handleStyleChange('creativity', value)}
          options={[
            { value: "factual", label: "Fáctica 📋" },
            { value: "balanced", label: "Balanceada 📊" },
            { value: "creative", label: "Creativa 🎨" }
          ]}
        />
        
        <FormField
          label="Persuasión"
          id="persuasiveness"
          type="select"
          value={state.styleControls?.persuasiveness}
          onChange={(value: any) => handleStyleChange('persuasiveness', value)}
          options={[
            { value: "informative", label: "Informativa ℹ️" },
            { value: "balanced", label: "Balanceada 📊" },
            { value: "persuasive", label: "Persuasiva 🔥" }
          ]}
        />
        
        <FormField
          label="Audiencia Objetivo"
          id="targetAudience"
          type="select"
          value={state.styleControls?.targetAudience}
          onChange={(value: any) => handleStyleChange('targetAudience', value)}
          options={[
            { value: "mixed", label: "Mixta 👥" },
            { value: "specific", label: "Específica 👤" }
          ]}
        />
        
        <FormField
          label="Engagement"
          id="engagement"
          type="select"
          value={state.styleControls?.engagement}
          onChange={(value: any) => handleStyleChange('engagement', value)}
          options={[
            { value: "professional", label: "Profesional 👔" },
            { value: "balanced", label: "Balanceado 📊" },
            { value: "engaging", label: "Atractivo 🤩" }
          ]}
        />
        
        <FormField
          label="Tamaño"
          id="size"
          type="select"
          value={state.styleControls?.size}
          onChange={(value: any) => handleStyleChange('size', value)}
          options={[
            { value: "short", label: "Corto 📄" },
            { value: "medium", label: "Medio 📃" },
            { value: "long", label: "Largo 📜" }
          ]}
        />
        
        <h4>Preferencias de Usuario</h4>
        
        <FormField
          label="En qué soy bueno"
          id="whatImGoodAt"
          type="textarea"
          value={state.whatImGoodAt}
          onChange={(value: any) => handleChange('whatImGoodAt', value)}
          placeholder="Digital marketing, SEO, content strategy"
        />
        
        <FormField
          label="Temas en los que estoy interesado"
          id="topicsImInterestedIn"
          type="textarea"
          value={state.topicsImInterestedIn}
          onChange={(value: any) => handleChange('topicsImInterestedIn', value)}
          placeholder="Tech, marketing, business growth"
        />
        
        <FormField
          label="Temas a evitar"
          id="topicsToAvoid"
          type="textarea"
          value={state.topicsToAvoid}
          onChange={(value: any) => handleChange('topicsToAvoid', value)}
          placeholder="Politics, controversial topics"
        />
        
        <FormField
          label="Instrucciones personalizadas"
          id="aiPrompt"
          type="textarea"
          value={state.aiPrompt}
          onChange={(value: any) => handleChange('aiPrompt', value)}
          placeholder="Make this content more engaging for small business owners"
        />
      </>
    );
  }
};

export default CopywriterApi; 