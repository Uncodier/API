'use client';

import React, { useState } from 'react';
import { UnifiedApiTester } from './UnifiedApiTester';
import styles from '../ApiTester.module.css';

interface UxAnalysisTesterProps {
  title?: string;
  description?: string;
  showUxInfo?: boolean;
}

/**
 * Componente especializado para probar la API de análisis UX y branding
 */
const UxAnalysisTester: React.FC<UxAnalysisTesterProps> = ({
  title = 'API de Análisis UX y Branding',
  description = 'Realiza análisis integral de UX y completa automáticamente el objeto settings.branding con recomendaciones, problemas y oportunidades.',
  showUxInfo = true
}) => {
  const [showInfo, setShowInfo] = useState(true);

  return (
    <div className={styles.emailOptimizationWrapper}>
      {showUxInfo && showInfo && (
        <div className={styles.optimizationInfo}>
          <div className={styles.infoHeader}>
            <h3>🎨 Análisis UX & Branding Automático</h3>
            <button 
              className={styles.closeInfo}
              onClick={() => setShowInfo(false)}
              aria-label="Cerrar información"
            >
              ×
            </button>
          </div>
          
          <div className={styles.infoGrid}>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>🔍</div>
              <h4>Análisis Integral</h4>
              <p>Evalúa usabilidad, accesibilidad, diseño visual y rendimiento del sitio web.</p>
            </div>
            
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>🎨</div>
              <h4>Branding Automático</h4>
              <p>Extrae y estructura elementos de marca: colores, tipografía, personalidad y guidelines.</p>
            </div>
            
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>💡</div>
              <h4>Recomendaciones UX</h4>
              <p>Genera insights accionables categorizados por prioridad y esfuerzo de implementación.</p>
            </div>
            
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>📊</div>
              <h4>Scores Detallados</h4>
              <p>Califica aspectos específicos de UX con métricas cuantificables del 0 al 100.</p>
            </div>
          </div>
          
          <div className={styles.exampleSection}>
            <h4>Ejemplo de Análisis UX:</h4>
            <div className={styles.exampleGrid}>
              <div className={styles.exampleBefore}>
                <h5>Entrada (Sitio Web)</h5>
                <code className={styles.exampleCode}>
                  URL: https://ejemplo.com<br/>
                  Site ID: uuid-del-sitio<br/>
                  User ID: uuid-del-usuario
                </code>
              </div>
              
              <div className={styles.exampleArrow}>→</div>
              
              <div className={styles.exampleAfter}>
                <h5>Salida (Análisis UX)</h5>
                <code className={styles.exampleCode}>
                  • Branding completado<br/>
                  • 15 recomendaciones<br/>
                  • 8 problemas identificados<br/>
                  • 12 oportunidades<br/>
                  • Scores UX detallados
                </code>
              </div>
            </div>
            <div className={styles.savingsHighlight}>
              💡 <strong>Resultado: Análisis UX integral + Branding automático</strong>
            </div>
          </div>
        </div>
      )}

      <UnifiedApiTester
        apiId="ux-analysis"
        title={title}
        description={description}
        defaultEndpoint="/api/agents/ux/analyze"
        defaultMethod="POST"
        showModelOptions={false}
        additionalFields={[
          {
            id: 'branding_auto_complete',
            label: 'Completado Automático de Branding ✨',
            type: 'info',
            value: 'El sistema extraerá automáticamente elementos de marca y completará el objeto settings.branding en la base de datos.',
            readOnly: true
          }
        ]}
      />

      {showUxInfo && (
        <div className={styles.optimizationTips}>
          <h4>🎯 Características del Análisis:</h4>
          <ul>
            <li><strong>Branding Pyramid:</strong> Extrae esencia, personalidad, beneficios, atributos, valores y promesa de marca.</li>
            <li><strong>Paleta de Colores:</strong> Identifica colores primarios, secundarios y de acento utilizados.</li>
            <li><strong>Tipografía:</strong> Analiza fuentes principales y secundarias del sitio.</li>
            <li><strong>Voz y Tono:</strong> Determina estilo de comunicación y rasgos de personalidad.</li>
            <li><strong>UX Scores:</strong> Califica usabilidad, accesibilidad, diseño, rendimiento y consistencia de marca.</li>
            <li><strong>Recomendaciones:</strong> Proporciona mejoras categorizadas por prioridad (alta/media/baja).</li>
            <li><strong>Problemas:</strong> Identifica issues críticos, altos, medios y bajos con impacto específico.</li>
            <li><strong>Oportunidades:</strong> Detecta áreas de mejora con potencial alto, medio o bajo.</li>
          </ul>
          
          <h4>📊 Scores UX Generados:</h4>
          <div className={styles.infoGrid}>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>📈</div>
              <h5>Overall Score</h5>
              <p>Puntuación general de UX (0-100)</p>
            </div>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>🖱️</div>
              <h5>Usability Score</h5>
              <p>Facilidad de uso y navegación</p>
            </div>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>♿</div>
              <h5>Accessibility Score</h5>
              <p>Cumplimiento de estándares de accesibilidad</p>
            </div>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>🎨</div>
              <h5>Visual Design Score</h5>
              <p>Calidad del diseño visual</p>
            </div>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>⚡</div>
              <h5>Performance Score</h5>
              <p>Rendimiento percibido</p>
            </div>
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>🏷️</div>
              <h5>Branding Consistency</h5>
              <p>Consistencia de elementos de marca</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UxAnalysisTester; 