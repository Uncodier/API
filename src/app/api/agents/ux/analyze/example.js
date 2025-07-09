/**
 * Ejemplo de uso de la API de Análisis UX y Branding
 * 
 * Este endpoint requiere únicamente el site_id para funcionar.
 * Obtiene automáticamente la información del sitio desde la base de datos.
 */

// Ejemplo básico con solo site_id
async function analyzeUXBasic() {
  try {
    const response = await fetch('/api/agents/ux/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        site_id: 'your-site-uuid-here'
      })
    });

    const result = await response.json();
    
    if (result.success) {
      console.log('✅ Análisis completado exitosamente');
      console.log('📊 Score UX general:', result.data.ux_assessment.overall_score);
      console.log('🎨 Branding actualizado:', result.data.branding);
      console.log('💡 Recomendaciones:', result.data.recommendations);
      console.log('🚨 Problemas encontrados:', result.data.problems);
      console.log('🎯 Oportunidades:', result.data.opportunities);
    } else {
      console.error('❌ Error en el análisis:', result.error);
    }
  } catch (error) {
    console.error('❌ Error de red:', error);
  }
}

// Ejemplo con opciones personalizadas
async function analyzeUXWithOptions() {
  try {
    const response = await fetch('/api/agents/ux/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        site_id: 'your-site-uuid-here',
        options: {
          timeout: 45000,
          includeScreenshot: true,
          provider: 'anthropic',
          modelId: 'claude-3-5-sonnet-20240620',
          updateBranding: true,
          language: 'es'
        }
      })
    });

    const result = await response.json();
    
    if (result.success) {
      console.log('✅ Análisis con opciones completado');
      
      // Mostrar información del sitio obtenida automáticamente
      console.log('🌐 Información del sitio:', {
        name: result.data.site_info.site.name,
        url: result.data.site_info.site.url,
        hasExistingBranding: !!result.data.site_info.settings?.branding
      });
      
      // Mostrar scores detallados
      console.log('📊 Evaluación UX detallada:', {
        overall: result.data.ux_assessment.overall_score,
        usability: result.data.ux_assessment.usability_score,
        accessibility: result.data.ux_assessment.accessibility_score,
        visual_design: result.data.ux_assessment.visual_design_score,
        performance: result.data.ux_assessment.performance_score,
        branding_consistency: result.data.ux_assessment.branding_consistency_score
      });
      
      // Mostrar recomendaciones críticas
      const criticalRecommendations = result.data.recommendations.filter(r => r.priority === 'alta');
      console.log('🚨 Recomendaciones críticas:', criticalRecommendations.map(r => ({
        category: r.category,
        title: r.title,
        impact: r.impact
      })));
      
      // Mostrar problemas severos
      const severeProblems = result.data.problems.filter(p => p.severity === 'crítico');
      console.log('⚠️ Problemas severos:', severeProblems.map(p => ({
        category: p.category,
        title: p.title,
        user_impact: p.user_impact
      })));
      
      // Mostrar oportunidades de alto potencial
      const highPotentialOpportunities = result.data.opportunities.filter(o => o.potential === 'alto');
      console.log('🎯 Oportunidades de alto potencial:', highPotentialOpportunities.map(o => ({
        category: o.category,
        title: o.title,
        expected_outcomes: o.expected_outcomes
      })));
      
    } else {
      console.error('❌ Error en el análisis:', result.error);
    }
  } catch (error) {
    console.error('❌ Error de red:', error);
  }
}

// Ejemplo de como verificar el estado del servicio
async function checkServiceStatus() {
  try {
    const response = await fetch('/api/agents/ux/analyze', {
      method: 'GET'
    });
    
    const info = await response.json();
    console.log('ℹ️ Información del servicio:', info);
  } catch (error) {
    console.error('❌ Error obteniendo información del servicio:', error);
  }
}

// Ejemplo de manejo de errores común
async function handleCommonErrors() {
  try {
    const response = await fetch('/api/agents/ux/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        site_id: 'invalid-uuid'
      })
    });

    const result = await response.json();
    
    if (!result.success) {
      switch (result.error?.type) {
        case 'VALIDATION_ERROR':
          console.error('❌ Error de validación:', result.error.message);
          break;
        case 'SITE_NOT_FOUND':
          console.error('❌ Sitio no encontrado:', result.error.message);
          break;
        case 'SITE_URL_MISSING':
          console.error('❌ URL del sitio faltante:', result.error.message);
          break;
        case 'USER_ID_MISSING':
          console.error('❌ User ID faltante:', result.error.message);
          break;
        case 'ANALYSIS_ERROR':
          console.error('❌ Error en el análisis:', result.error.message);
          break;
        default:
          console.error('❌ Error desconocido:', result.error);
      }
    }
  } catch (error) {
    console.error('❌ Error de red:', error);
  }
}

// Ejemplo de uso en frontend con React
async function useInReactComponent() {
  const [analysisResult, setAnalysisResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const analyzeUX = async (siteId) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch('/api/agents/ux/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          site_id: siteId
        })
      });

      const result = await response.json();
      
      if (result.success) {
        setAnalysisResult(result.data);
      } else {
        setError(result.error.message);
      }
    } catch (err) {
      setError('Error de red al analizar el sitio');
    } finally {
      setLoading(false);
    }
  };

  return {
    analysisResult,
    loading,
    error,
    analyzeUX
  };
}

// Ejecutar ejemplos (descomenta para probar)
// analyzeUXBasic();
// analyzeUXWithOptions();
// checkServiceStatus();
// handleCommonErrors();

export {
  analyzeUXBasic,
  analyzeUXWithOptions,
  checkServiceStatus,
  handleCommonErrors,
  useInReactComponent
}; 