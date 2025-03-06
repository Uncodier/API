"use client";

import { useState, useEffect } from 'react';
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title } from 'chart.js';
import { Pie, Bar } from 'react-chartjs-2';

// Register Chart.js components
ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title);

// Define the types for our structured analysis
interface BlockInfo {
  id: string;
  type: string;
  section_type?: string;
  selector: string;
  classes: string[];
  content_type: string;
  relevance: {
    score: number;
    reason: string;
  };
  children: number;
  text_length: number;
  location: {
    position: string;
    coordinates: {
      top: number;
      left: number;
    };
  };
  ux_role?: string;
  interaction_model?: string;
  content_density?: string;
  attention_direction?: string;
  hierarchy_level?: string;
  visual_weight?: string;
  description?: string;
  sub_blocks?: SubBlockInfo[];
  subBlocks?: SubBlockInfo[];
}

interface SubBlockInfo {
  type: string;
  text: string;
  selector: string;
  action?: string;
  function?: string;
  interactive?: boolean;
  prominence?: string;
  relevance?: number;
  location?: string;
  nested_elements?: NestedElement[];
  attributes?: {
    href?: string;
    target?: string;
    id?: string;
    class?: string[];
    [key: string]: any;
  };
}

interface NestedElement {
  type?: string;
  role?: string;
  interactive?: boolean;
  [key: string]: any;
}

interface SiteInfo {
  url: string;
  title: string;
  description: string;
  language: string;
}

interface NavigationItem {
  name: string;
  location: string;
  items: string[];
}

interface Hierarchy {
  main_sections: string[];
  navigation_structure: NavigationItem[];
  user_flow?: {
    primary_path: string[];
  };
}

interface Overview {
  total_blocks: number;
  primary_content_blocks: number;
  navigation_blocks: number;
  interactive_elements: number;
  key_ux_patterns: string[];
  design_system_characteristics: string[];
}

interface UXAnalysis {
  cta_elements: Array<{
    text: string;               // The text on the CTA
    type?: string;              // Type of CTA (primary, secondary, tertiary)
    purpose?: string;           // CTA's purpose (signup, demo, purchase, etc)
    location: string;           // Where the CTA is located
    prominence: string;         // Visual prominence
    design_pattern: string;     // Design pattern used
    urgency_factor?: string;    // Urgency creation technique
    contrast_level?: string;    // Visual contrast with surroundings
    visual_style?: string;      // Style of the CTA
    size?: string;              // Size relative to surrounding elements
    mobile_adaptation?: string; // How it adapts on mobile
    effectiveness_score?: number; // Estimated effectiveness score
    selector?: string;          // CSS selector to identify this CTA
  }>;
  navigation_elements: Array<{
    type: string;
    location: string;
    items: string[];
  }>;
  forms: Array<{
    purpose: string;
    fields: string[];
    user_friction: string;
  }>;
  content_hierarchy: {
    primary_content: string[];
    supporting_content: string[];
  };
  visual_patterns: {
    color_usage: string;
    spacing_patterns: string;
    typography_hierarchy: string;
  };
}

interface StructuredAnalysisData {
  site_info: SiteInfo;
  blocks: BlockInfo[];
  hierarchy: Hierarchy;
  overview: Overview;
  ux_analysis?: UXAnalysis;
  metadata: {
    analyzed_by: string;
    timestamp: string;
    model_used: string;
    status: 'success' | 'error' | 'pending';
  };
}

// Definir interfaz para los elementos CTA
interface CTAElement {
  text: string;
  type?: string;
  purpose?: string;
  location: string;
  prominence: string;
  design_pattern: string;
  urgency_factor?: string;
  contrast_level?: string;
  visual_style?: string;
  size?: string;
  mobile_adaptation?: string;
  effectiveness_score?: number;
  selector?: string;
}

const StructuredAnalysis = ({ analysisData }: { analysisData: any }) => {
  const [activeTab, setActiveTab] = useState('blocks');
  const [debugMode, setDebugMode] = useState(false);
  const [viewMode, setViewMode] = useState<'structural' | 'detailed'>('structural');

  // Verificar si tenemos datos válidos - Mejorar la detección de datos
  if (!analysisData) {
    return (
      <div className="p-4 border rounded-lg bg-gray-50">
        <h3 className="text-lg font-semibold text-gray-700">Structured Analysis</h3>
        <p className="text-gray-500 mt-2">No structured analysis data available.</p>
      </div>
    );
  }

  console.log("StructuredAnalysis received data:", analysisData);

  // Intentar extraer los datos de diferentes formatos posibles
  let structuredData;
  
  // Caso 1: Si analysisData ya es el objeto de análisis estructurado
  if (analysisData.site_info && analysisData.blocks) {
    console.log("Case 1: Direct structured data object");
    structuredData = analysisData;
  } 
  // Caso 2: Si analysisData.structuredAnalysis contiene los datos
  else if (analysisData.structuredAnalysis && typeof analysisData.structuredAnalysis === 'object') {
    console.log("Case 2: Data in structuredAnalysis property");
    structuredData = analysisData.structuredAnalysis;
  }
  // Caso 3: Si analysisData.result contiene los datos
  else if (analysisData.result && typeof analysisData.result === 'object') {
    console.log("Case 3: Data in result property");
    if (analysisData.result.site_info && analysisData.result.blocks) {
      structuredData = analysisData.result;
    } else if (analysisData.result.structuredAnalysis) {
      structuredData = analysisData.result.structuredAnalysis;
    }
  }
  // Caso 4: Si analysisData es un string JSON
  else if (typeof analysisData === 'string') {
    console.log("Case 4: String JSON data");
    try {
      const parsed = JSON.parse(analysisData);
      if (parsed.site_info && parsed.blocks) {
        structuredData = parsed;
      } else if (parsed.structuredAnalysis) {
        structuredData = parsed.structuredAnalysis;
      } else if (parsed.result && parsed.result.site_info) {
        structuredData = parsed.result;
      }
    } catch (e) {
      console.error('Error parsing JSON data:', e);
    }
  }
  
  // Si después de intentar todos los formatos no tenemos datos válidos
  if (!structuredData || !structuredData.site_info || !structuredData.blocks) {
    console.error('Invalid structured analysis data format:', analysisData);
    return (
      <div className="p-4 border rounded-lg bg-gray-50">
        <h3 className="text-lg font-semibold text-gray-700">Structured Analysis</h3>
        <p className="text-gray-500 mt-2">Invalid structured analysis data format.</p>
        <div className="mt-4 flex justify-between items-center">
          <button 
            onClick={() => setDebugMode(!debugMode)}
            className="text-xs text-blue-500 hover:text-blue-700"
          >
            {debugMode ? "Hide Debug Info" : "Show Debug Info"}
          </button>
        </div>
        {debugMode && (
          <div className="mt-2">
            <h4 className="text-sm font-medium">Data Structure:</h4>
            <pre className="mt-2 p-2 bg-gray-100 rounded overflow-auto max-h-96 text-xs">
              {JSON.stringify(analysisData, null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // Extract analysis data
  const { site_info, blocks, hierarchy, overview, ux_analysis } = structuredData;

  // Log the number of blocks for debugging
  console.log(`Rendering ${blocks.length} blocks from structured analysis`);

  // Dentro del componente StructuredAnalysis, añadir una función para obtener el color según el rol UX
  const getUxRoleStyles = (uxRole: string | undefined) => {
    if (!uxRole) return { bg: 'bg-gray-100', text: 'text-gray-800' };
    
    switch (uxRole) {
      // Categorías de información
      case 'product-info':
        return { bg: 'bg-indigo-100', text: 'text-indigo-800' };
      case 'company-info':
        return { bg: 'bg-sky-100', text: 'text-sky-800' };
      case 'educational':
        return { bg: 'bg-teal-100', text: 'text-teal-800' };
      case 'feature-highlight':
        return { bg: 'bg-cyan-100', text: 'text-cyan-800' };
      case 'stats-metrics':
        return { bg: 'bg-orange-100', text: 'text-orange-800' };
      case 'technical-specs':
        return { bg: 'bg-slate-100', text: 'text-slate-800' };
      case 'news-update':
        return { bg: 'bg-rose-100', text: 'text-rose-800' };
      
      // E-commerce y ventas
      case 'product-listing':
        return { bg: 'bg-amber-100', text: 'text-amber-800' };
      case 'product-comparison':
        return { bg: 'bg-yellow-100', text: 'text-yellow-800' };
      case 'pricing-display':
        return { bg: 'bg-lime-100', text: 'text-lime-800' };
      case 'inventory-status':
        return { bg: 'bg-emerald-100', text: 'text-emerald-800' };
      case 'purchase-process':
        return { bg: 'bg-green-100', text: 'text-green-800' };
      
      // Plataforma específica
      case 'user-generated':
        return { bg: 'bg-fuchsia-100', text: 'text-fuchsia-800' };
      case 'community-engagement':
        return { bg: 'bg-purple-100', text: 'text-purple-800' };
      case 'personalized-content':
        return { bg: 'bg-violet-100', text: 'text-violet-800' };
      case 'media-showcase':
        return { bg: 'bg-pink-100', text: 'text-pink-800' };
      case 'interactive-tool':
        return { bg: 'bg-red-100', text: 'text-red-800' };
      
      // Plataformas digitales
      case 'onboarding':
        return { bg: 'bg-blue-100', text: 'text-blue-800' };
      case 'account-management':
        return { bg: 'bg-sky-100', text: 'text-sky-800' };
      case 'dashboard-summary':
        return { bg: 'bg-cyan-100', text: 'text-cyan-800' };
      case 'progress-tracking':
        return { bg: 'bg-teal-100', text: 'text-teal-800' };
      case 'notification-alert':
        return { bg: 'bg-emerald-100', text: 'text-emerald-800' };
      
      // Contenido especializado
      case 'location-based':
        return { bg: 'bg-amber-100', text: 'text-amber-800' };
      case 'time-sensitive':
        return { bg: 'bg-orange-100', text: 'text-orange-800' };
      case 'regulatory-info':
        return { bg: 'bg-stone-100', text: 'text-stone-800' };
      case 'research-findings':
        return { bg: 'bg-neutral-100', text: 'text-neutral-800' };
      case 'expertise-demonstration':
        return { bg: 'bg-zinc-100', text: 'text-zinc-800' };
      case 'certification-recognition':
        return { bg: 'bg-slate-100', text: 'text-slate-800' };
      
      // Categorías UX estándar
      case 'navigation':
      case 'trust-security':
        return { bg: 'bg-lime-100', text: 'text-lime-800' };
      case 'legal-compliance':
        return { bg: 'bg-neutral-100', text: 'text-neutral-800' };
      default:
        return { bg: 'bg-gray-100', text: 'text-gray-800' };
    }
  };

  // Añadir una función para obtener estilos para los modelos de interacción
  const getInteractionModelStyles = (model: string | undefined) => {
    if (!model) return { bg: 'bg-gray-100', text: 'text-gray-800' };
    
    switch (model) {
      case 'click-through':
        return { bg: 'bg-blue-50', text: 'text-blue-800' };
      case 'form-input':
        return { bg: 'bg-teal-50', text: 'text-teal-800' };
      case 'hover-reveal':
        return { bg: 'bg-indigo-50', text: 'text-indigo-800' };
      case 'scroll-triggered':
        return { bg: 'bg-amber-50', text: 'text-amber-800' };
      case 'swipe-navigation':
        return { bg: 'bg-purple-50', text: 'text-purple-800' };
      default:
        return { bg: 'bg-gray-50', text: 'text-gray-800' };
    }
  };

  // Añadir una función para obtener estilos para la densidad de contenido
  const getContentDensityStyles = (density: string | undefined) => {
    if (!density) return { bg: 'bg-gray-100', text: 'text-gray-800' };
    
    switch (density) {
      case 'minimal':
        return { bg: 'bg-sky-50', text: 'text-sky-800' };
      case 'moderate':
        return { bg: 'bg-blue-50', text: 'text-blue-800' };
      case 'high-density':
        return { bg: 'bg-indigo-50', text: 'text-indigo-800' };
      default:
        return { bg: 'bg-gray-50', text: 'text-gray-800' };
    }
  };

  // Añadir una función para obtener estilos para la dirección de atención
  const getAttentionDirectionStyles = (direction: string | undefined) => {
    if (!direction) return { bg: 'bg-gray-100', text: 'text-gray-800' };
    
    switch (direction) {
      case 'focal-point':
        return { bg: 'bg-red-50', text: 'text-red-800' };
      case 'sequential-flow':
        return { bg: 'bg-amber-50', text: 'text-amber-800' };
      case 'distributed-attention':
        return { bg: 'bg-violet-50', text: 'text-violet-800' };
      default:
        return { bg: 'bg-gray-50', text: 'text-gray-800' };
    }
  };

  // Función para obtener estilos para los tipos de CTA
  const getCTATypeStyles = (type: string | undefined) => {
    if (!type) return { bg: 'bg-blue-100', text: 'text-blue-800', border: 'border-blue-200' };
    
    switch (type?.toLowerCase()) {
      case 'primary':
        return { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200' };
      case 'secondary':
        return { bg: 'bg-purple-100', text: 'text-purple-800', border: 'border-purple-200' };
      case 'tertiary':
        return { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-200' };
      default:
        return { bg: 'bg-blue-100', text: 'text-blue-800', border: 'border-blue-200' };
    }
  };

  // Función para obtener estilos para los propósitos de CTA
  const getCTAPurposeStyles = (purpose: string | undefined) => {
    if (!purpose) return { bg: 'bg-gray-100', text: 'text-gray-800' };
    
    switch (purpose?.toLowerCase()) {
      case 'signup':
        return { bg: 'bg-emerald-50', text: 'text-emerald-800' };
      case 'demo':
        return { bg: 'bg-cyan-50', text: 'text-cyan-800' };
      case 'purchase':
        return { bg: 'bg-green-50', text: 'text-green-800' };
      case 'download':
        return { bg: 'bg-blue-50', text: 'text-blue-800' };
      case 'contact':
        return { bg: 'bg-indigo-50', text: 'text-indigo-800' };
      case 'learn-more':
        return { bg: 'bg-violet-50', text: 'text-violet-800' };
      case 'trial':
        return { bg: 'bg-teal-50', text: 'text-teal-800' };
      default:
        return { bg: 'bg-gray-50', text: 'text-gray-800' };
    }
  };

  // Render menus
  const renderMenus = () => {
    if (!ux_analysis?.navigation_elements || ux_analysis.navigation_elements.length === 0) {
      return <p className="text-gray-500">No menus found on the site.</p>;
    }

    return ux_analysis.navigation_elements.map((menu: any, index: number) => (
      <div key={index} className="mb-4 p-3 border rounded-lg bg-white">
        <h4 className="font-medium text-blue-600">Menu in {menu.location}</h4>
        <div className="mt-2">
          <span className="text-sm font-medium text-gray-500">Elements: </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {menu.items.map((item: string, idx: number) => (
              <span key={idx} className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded-md">
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>
    ));
  };

  // Función mejorada para renderizar los CTAs
  const renderCTAs = () => {
    if (!ux_analysis?.cta_elements || ux_analysis.cta_elements.length === 0) {
      return (
        <div className="mt-4 p-4 bg-gray-50 rounded-md">
          <p className="text-gray-500">No CTA elements found in the analysis.</p>
        </div>
      );
    }

    return (
      <div className="mt-5">
        <h3 className="text-xl font-semibold mb-3">Call-to-Action Elements</h3>
        <div className="space-y-4">
          {ux_analysis.cta_elements.map((cta: CTAElement, index: number) => {
            const typeStyles = getCTATypeStyles(cta.type);
            const purposeStyles = getCTAPurposeStyles(cta.purpose);
            
            return (
              <div key={index} className={`border rounded-lg p-4 shadow-sm ${typeStyles.border}`}>
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-lg font-medium ${typeStyles.text}`}>"{cta.text}"</span>
                      {cta.type && (
                        <span className={`px-2 py-0.5 rounded-full text-xs ${typeStyles.bg} ${typeStyles.text}`}>
                          {cta.type}
                        </span>
                      )}
                    </div>
                    
                    <div className="grid grid-cols-2 gap-x-8 gap-y-2 mt-2">
                      {cta.purpose && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-sm">Purpose:</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${purposeStyles.bg} ${purposeStyles.text}`}>
                            {cta.purpose}
                          </span>
                        </div>
                      )}
                      
                      <div className="flex items-center gap-1">
                        <span className="font-medium text-sm">Location:</span>
                        <span className="text-sm">{cta.location}</span>
                      </div>
                      
                      <div className="flex items-center gap-1">
                        <span className="font-medium text-sm">Design:</span>
                        <span className="text-sm">{cta.design_pattern}</span>
                      </div>
                      
                      <div className="flex items-center gap-1">
                        <span className="font-medium text-sm">Prominence:</span>
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          cta.prominence === 'high' ? 'bg-red-100 text-red-800' :
                          cta.prominence === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                          'bg-gray-100 text-gray-800'
                        }`}>
                          {cta.prominence}
                        </span>
                      </div>
                      
                      {cta.urgency_factor && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-sm">Urgency Factor:</span>
                          <span className="text-sm">{cta.urgency_factor}</span>
                        </div>
                      )}
                      
                      {cta.contrast_level && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-sm">Contrast:</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            cta.contrast_level === 'high' ? 'bg-purple-100 text-purple-800' :
                            cta.contrast_level === 'medium' ? 'bg-indigo-100 text-indigo-800' :
                            'bg-gray-100 text-gray-800'
                          }`}>
                            {cta.contrast_level}
                          </span>
                        </div>
                      )}
                      
                      {cta.visual_style && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-sm">Style:</span>
                          <span className="text-sm">{cta.visual_style}</span>
                        </div>
                      )}
                      
                      {cta.size && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-sm">Size:</span>
                          <span className="text-sm">{cta.size}</span>
                        </div>
                      )}
                      
                      {cta.mobile_adaptation && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-sm">Mobile:</span>
                          <span className="text-sm">{cta.mobile_adaptation}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {cta.effectiveness_score !== undefined && (
                    <div className="text-right">
                      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border-2 border-blue-200 text-blue-800 font-bold">
                        {cta.effectiveness_score}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">Effectiveness</div>
                    </div>
                  )}
                </div>
                
                {cta.selector && (
                  <div className="mt-2 pt-2 border-t border-gray-100">
                    <code className="text-xs bg-gray-50 p-1 rounded font-mono">{cta.selector}</code>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render forms
  const renderForms = () => {
    if (!ux_analysis?.forms || ux_analysis.forms.length === 0) {
      return <p className="text-gray-500">No forms found on the site.</p>;
    }

    return ux_analysis.forms.map((form: {purpose: string; fields: string[]; user_friction: string}, idx: number) => (
      <div key={idx} className="mb-4 p-3 border rounded-lg bg-white">
        <h4 className="font-medium text-purple-600">Form for {form.purpose}</h4>
        <p className="text-sm text-gray-500">Possible friction: {form.user_friction}</p>
        <div className="mt-2">
          <span className="text-sm font-medium text-gray-500">Fields: </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {form.fields.map((field: string, fieldIdx: number) => (
              <span key={fieldIdx} className="px-2 py-1 bg-purple-50 text-purple-700 text-xs rounded-md">
                {field}
              </span>
            ))}
          </div>
        </div>
      </div>
    ));
  };

  // Actualizar la función renderBlocks para mostrar las nuevas propiedades (interaction_model, content_density, attention_direction) en la visualización de los bloques
  const renderBlocks = () => {
    if (!blocks || blocks.length === 0) {
      return (
        <div className="mt-4 p-4 bg-gray-50 rounded-md">
          <p className="text-gray-500">No block information available.</p>
        </div>
      );
    }

    // Log block data for debugging
    console.log("Blocks to render:", blocks);
    
    // Filtrar bloques según el modo de visualización
    const filteredBlocks = filterBlocksByViewMode(blocks);
    console.log(`Filtered blocks (${viewMode} mode):`, filteredBlocks.length);

    return (
      <div className="mt-4">
        <h3 className="text-xl font-semibold mb-2">Blocks Structure ({filteredBlocks.length} blocks)</h3>
        <div className="space-y-3">
          {filteredBlocks.map((block: BlockInfo, index: number) => {
            // Validar que el bloque tenga la estructura esperada
            if (!block) {
              console.warn(`Block at index ${index} is undefined or null`);
              return null;
            }

            // Log individual block for debugging
            console.log(`Rendering block ${index}:`, block);

            return (
              <div key={index} className="border p-3 rounded-md bg-white shadow-sm">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold">{block.type || 'Unknown Type'}</span>
                      {block.section_type && (
                        <span className="bg-blue-100 text-blue-800 text-xs font-medium px-2 py-0.5 rounded">
                          {block.section_type}
                        </span>
                      )}
                      {block.id && <span className="text-gray-500 text-sm">#{block.id}</span>}
                    </div>
                    
                    {block.description && (
                      <p className="text-gray-700 text-sm mt-1">{block.description}</p>
                    )}
                    
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-sm">
                      {block.ux_role && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium">UX Role:</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${getUxRoleStyles(block.ux_role).bg} ${getUxRoleStyles(block.ux_role).text}`}>
                            {block.ux_role}
                          </span>
                        </div>
                      )}
                      
                      {block.interaction_model && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium">Interaction:</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${getInteractionModelStyles(block.interaction_model).bg} ${getInteractionModelStyles(block.interaction_model).text}`}>
                            {block.interaction_model}
                          </span>
                        </div>
                      )}
                      
                      {block.visual_weight && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium">Visual Weight:</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            block.visual_weight === 'high' ? 'bg-red-100 text-red-800' :
                            block.visual_weight === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                            'bg-gray-100 text-gray-800'
                          }`}>
                            {block.visual_weight}
                          </span>
                        </div>
                      )}
                      
                      {block.content_density && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium">Density:</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${getContentDensityStyles(block.content_density).bg} ${getContentDensityStyles(block.content_density).text}`}>
                            {block.content_density}
                          </span>
                        </div>
                      )}
                      
                      {block.hierarchy_level && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium">Hierarchy:</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            block.hierarchy_level === 'primary' ? 'bg-indigo-100 text-indigo-800' :
                            block.hierarchy_level === 'secondary' ? 'bg-blue-100 text-blue-800' :
                            'bg-teal-100 text-teal-800'
                          }`}>
                            {block.hierarchy_level}
                          </span>
                        </div>
                      )}
                      
                      {block.attention_direction && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium">Attention:</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${getAttentionDirectionStyles(block.attention_direction).bg} ${getAttentionDirectionStyles(block.attention_direction).text}`}>
                            {block.attention_direction}
                          </span>
                        </div>
                      )}
                      
                      {block.location?.position && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium">Position:</span>
                          <span>{block.location.position}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="text-right">
                    <div className="px-2 py-1 bg-gray-100 rounded text-xs">
                      Relevance: {block.relevance?.score || 0}/100
                    </div>
                    {block.relevance?.reason && (
                      <div className="text-xs text-gray-500 mt-1 max-w-xs">
                        {block.relevance.reason}
                      </div>
                    )}
                  </div>
                </div>
                
                {/* Sub-blocks */}
                {((block.subBlocks && block.subBlocks.length > 0) || (block.sub_blocks && block.sub_blocks.length > 0)) && (
                  <div className="mt-3 pl-4 border-l-2 border-gray-200">
                    <div className="text-sm font-medium mb-1">
                      Sub-blocks: {(block.subBlocks?.length || block.sub_blocks?.length || 0)}
                    </div>
                    <div className="space-y-2">
                      {(block.subBlocks || block.sub_blocks || []).map((subBlock: SubBlockInfo, subIndex: number) => {
                        if (!subBlock) {
                          console.warn(`Sub-block at index ${subIndex} in block ${index} is undefined or null`);
                          return null;
                        }
                        
                        return (
                          <div key={subIndex} className="bg-gray-50 p-2 rounded text-sm">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{subBlock.type || 'Unknown'}</span>
                              {subBlock.function && (
                                <span className={`px-2 py-0.5 rounded-sm text-xs ${getUxRoleStyles(subBlock.function).bg} ${getUxRoleStyles(subBlock.function).text}`}>
                                  {subBlock.function}
                                </span>
                              )}
                            </div>
                            {subBlock.text && <div className="text-gray-700 mt-1">{subBlock.text}</div>}
                            
                            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1 text-xs">
                              {subBlock.interactive !== undefined && (
                                <div>Interactive: {subBlock.interactive ? 'Yes' : 'No'}</div>
                              )}
                              {subBlock.prominence && <div>Prominence: {subBlock.prominence}</div>}
                              {subBlock.location && <div>Location: {subBlock.location}</div>}
                              {subBlock.action && <div>Action: {subBlock.action}</div>}
                              {subBlock.relevance !== undefined && <div>Relevance: {subBlock.relevance}</div>}
                            </div>
                            
                            {/* Attributes if any */}
                            {subBlock.attributes && Object.keys(subBlock.attributes).length > 0 && (
                              <div className="mt-1 text-xs">
                                <span className="font-medium">Attributes: </span>
                                {Object.entries(subBlock.attributes)
                                  .filter(([key, value]) => value !== undefined && value !== null)
                                  .map(([key, value], i) => (
                                    <span key={i} className="ml-1">
                                      {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                      {i < Object.keys(subBlock.attributes || {}).length - 1 ? ', ' : ''}
                                    </span>
                                  ))}
                              </div>
                            )}
                            
                            {/* Nested elements (if any) */}
                            {subBlock.nested_elements && subBlock.nested_elements.length > 0 && (
                              <div className="mt-1.5 pl-3 border-l border-gray-300">
                                <div className="text-xs font-medium mb-0.5">
                                  Nested elements: {subBlock.nested_elements.length}
                                </div>
                                <div className="space-y-1">
                                  {subBlock.nested_elements.map((nestedEl: NestedElement, neIdx: number) => {
                                    if (!nestedEl) {
                                      console.warn(`Nested element at index ${neIdx} is undefined or null`);
                                      return null;
                                    }
                                    
                                    return (
                                      <div key={neIdx} className="text-xs bg-gray-100 p-1 rounded">
                                        {nestedEl.type && <span>{nestedEl.type}</span>}
                                        {nestedEl.role && <span> - {nestedEl.role}</span>}
                                        {nestedEl.interactive !== undefined && 
                                          <span> ({nestedEl.interactive ? 'interactive' : 'non-interactive'})</span>}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render findings
  const renderFindings = () => {
    return (
      <div>
        {overview?.key_ux_patterns && overview.key_ux_patterns.length > 0 && (
          <div className="mb-4">
            <h4 className="font-medium text-gray-700 mb-2">Key UX patterns</h4>
            <ul className="list-disc pl-5 space-y-1">
              {overview.key_ux_patterns.map((pattern: string, idx: number) => (
                <li key={idx} className="text-gray-600">{pattern}</li>
              ))}
            </ul>
          </div>
        )}
        
        {overview?.design_system_characteristics && overview.design_system_characteristics.length > 0 && (
          <div>
            <h4 className="font-medium text-gray-700 mb-2">Design system characteristics</h4>
            <ul className="list-disc pl-5 space-y-1">
              {overview.design_system_characteristics.map((characteristic: string, idx: number) => (
                <li key={idx} className="text-gray-600">{characteristic}</li>
              ))}
            </ul>
          </div>
        )}
        
        {(!overview?.key_ux_patterns || overview.key_ux_patterns.length === 0) && 
         (!overview?.design_system_characteristics || overview.design_system_characteristics.length === 0) && (
          <p className="text-gray-500">No key UX patterns or design system characteristics available.</p>
        )}
      </div>
    );
  };

  // Función para filtrar bloques según el modo de visualización
  const filterBlocksByViewMode = (blocks: BlockInfo[]): BlockInfo[] => {
    if (!blocks) return [];
    
    if (viewMode === 'structural') {
      // Filtrar para mostrar solo bloques estructurales principales
      return blocks.filter(block => {
        if (!block) return false;
        
        // Considerar estructurales los que tienen estos tipos
        const structuralTypes = [
          'header', 'nav', 'main', 'footer', 'section', 'article', 'aside',
          'hero', 'features', 'testimonials', 'pricing', 'cta', 'contact',
          'banner', 'container', 'wrapper'
        ];
        
        // Verificar si el tipo del bloque es estructural
        const isStructuralType = block.type && structuralTypes.some(type => 
          block.type.toLowerCase().includes(type)
        );
        
        // Verificar si tiene sub-bloques (indicativo de ser un contenedor)
        const hasSubBlocks = (block.sub_blocks && block.sub_blocks.length > 0) || 
                            (block.subBlocks && block.subBlocks.length > 0);
        
        // Verificar si tiene una relevancia alta
        const hasHighRelevance = block.relevance && block.relevance.score > 70;
        
        // Verificar si es un bloque de sección
        const isSectionType = block.section_type === 'section' || 
                             block.section_type === 'container' ||
                             block.ux_role === 'section';
        
        return Boolean(isStructuralType || hasSubBlocks || hasHighRelevance || isSectionType);
      });
    } else {
      // Mostrar todos los bloques en modo detallado
      return blocks;
    }
  };

  // Render hierarchy
  const renderHierarchy = () => {
    if (!hierarchy) {
      return (
        <div className="mt-4 p-4 bg-gray-50 rounded-md">
          <p className="text-gray-500">No hierarchy information available.</p>
        </div>
      );
    }

    return (
      <div className="mt-4">
        <h3 className="text-xl font-semibold mb-4">Site Hierarchy</h3>
        
        {/* Main sections */}
        <div className="mb-6">
          <h4 className="font-medium text-gray-700 border-b pb-2 mb-3">Main Sections</h4>
          {hierarchy.main_sections && hierarchy.main_sections.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {hierarchy.main_sections.map((section: string, idx: number) => (
                <span key={idx} className="px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-md">
                  {section}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">No information about main sections available.</p>
          )}
        </div>
        
        {/* Navigation structure */}
        <div className="mb-6">
          <h4 className="font-medium text-gray-700 border-b pb-2 mb-3">Navigation Structure</h4>
          {hierarchy.navigation_structure && hierarchy.navigation_structure.length > 0 ? (
            <div className="space-y-4">
              {hierarchy.navigation_structure.map((nav: NavigationItem, idx: number) => (
                <div key={idx} className="p-3 bg-blue-50 border border-blue-100 rounded-lg">
                  <p className="font-medium text-blue-700">{nav.name}</p>
                  <p className="text-sm text-gray-600 mt-1">Location: {nav.location}</p>
                  {nav.items && nav.items.length > 0 && (
                    <div className="mt-2">
                      <p className="text-sm font-medium text-gray-600">Items:</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {nav.items.map((item: string, itemIdx: number) => (
                          <span key={itemIdx} className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-md">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">No navigation structure information available.</p>
          )}
        </div>
        
        {/* User flow if it exists */}
        {hierarchy.user_flow && (
          <div className="mb-6">
            <h4 className="font-medium text-gray-700 border-b pb-2 mb-3">User Flow</h4>
            {hierarchy.user_flow.primary_path && hierarchy.user_flow.primary_path.length > 0 ? (
              <div>
                <p className="font-medium text-gray-600 mb-2">Primary path:</p>
                <div className="flex items-center flex-wrap">
                  {hierarchy.user_flow.primary_path.map((step: string, idx: number) => (
                    <div key={idx} className="flex items-center">
                      <span className="px-3 py-1.5 bg-green-50 text-green-700 rounded-md">
                        {step}
                      </span>
                      {idx < hierarchy.user_flow.primary_path.length - 1 && (
                        <svg className="h-4 w-4 mx-1 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-gray-500">No information about user flow available.</p>
            )}
          </div>
        )}
      </div>
    );
  };

  // Tabs for different sections
  const tabs = [
    { id: 'blocks', label: 'Blocks' },
    { id: 'hierarchy', label: 'Hierarchy' },
    { id: 'menus', label: 'Navigation' },
    { id: 'ctas', label: 'CTAs' },
    { id: 'forms', label: 'Forms' },
    { id: 'findings', label: 'Findings' }
  ];

  return (
    <div className="bg-white rounded-lg shadow-sm border p-4">
      {/* Site Info Header */}
      <div className="mb-4">
        <h2 className="text-xl font-bold">{site_info.title || 'Untitled Site'}</h2>
        <div className="text-gray-500 text-sm mt-1">{site_info.url}</div>
        {site_info.description && (
          <div className="mt-2 text-gray-700">{site_info.description}</div>
        )}
        <div className="text-sm text-gray-500 mt-1">
          Language: {site_info.language || 'Not specified'}
        </div>
      </div>
      
      {/* View Mode Toggle */}
      <div className="flex justify-between items-center mb-4">
        <div className="flex space-x-2">
          <button
            onClick={() => setViewMode('structural')}
            className={`px-3 py-1 text-sm rounded-md ${
              viewMode === 'structural' 
                ? 'bg-blue-100 text-blue-700 font-medium' 
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Structural Blocks
          </button>
          <button
            onClick={() => setViewMode('detailed')}
            className={`px-3 py-1 text-sm rounded-md ${
              viewMode === 'detailed' 
                ? 'bg-blue-100 text-blue-700 font-medium' 
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            All Elements
          </button>
        </div>
        
        <div className="text-xs text-gray-500">
          {viewMode === 'structural' 
            ? 'Showing major structural blocks only' 
            : 'Showing all detected elements'}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b mb-4">
        <div className="flex space-x-4 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`pb-2 px-1 text-sm font-medium ${
                activeTab === tab.id
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="mt-4">
        {activeTab === 'blocks' && renderBlocks()}
        {activeTab === 'hierarchy' && renderHierarchy()}
        {activeTab === 'menus' && renderMenus()}
        {activeTab === 'ctas' && renderCTAs()}
        {activeTab === 'forms' && renderForms()}
        {activeTab === 'findings' && renderFindings()}
      </div>
    </div>
  );
};

export default StructuredAnalysis; 