'use client';

import React, { useState } from 'react';
import { UnifiedApiTester } from './UnifiedApiTester';
import styles from '../ApiTester.module.css';

interface EmailOptimizationTesterProps {
  title?: string;
  description?: string;
  showOptimizationInfo?: boolean;
}

/**
 * Componente especializado para probar la API de emails con optimización de texto
 */
const EmailOptimizationTester: React.FC<EmailOptimizationTesterProps> = ({
  title = 'API de Análisis de Emails - Con Optimización de Texto',
  description = 'Prueba la nueva funcionalidad de optimización de texto que reduce significativamente el uso de tokens al eliminar contenido innecesario como firmas, disclaimers y texto citado.',
  showOptimizationInfo = true
}) => {
  const [showInfo, setShowInfo] = useState(true);

  return (
    <div className={styles.emailOptimizationWrapper}>
      {showOptimizationInfo && showInfo && (
        <div className={styles.optimizationInfo}>
          <div className={styles.infoHeader}>
            <h3>🚀 Nueva Funcionalidad: Optimización de Texto para Emails</h3>
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
              <div className={styles.infoIcon}>📧</div>
              <h4>Texto Limpio</h4>
              <p>Elimina automáticamente firmas, headers, disclaimers legales y texto citado de emails.</p>
            </div>
            
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>💰</div>
              <h4>Ahorro de Tokens</h4>
              <p>Reduce entre 60-80% el uso de tokens, disminuyendo significativamente los costos de IA.</p>
            </div>
            
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>⚡</div>
              <h4>Mejor Análisis</h4>
              <p>Al enfocarse solo en contenido relevante, los modelos de IA proporcionan análisis más precisos.</p>
            </div>
            
            <div className={styles.infoCard}>
              <div className={styles.infoIcon}>📊</div>
              <h4>Métricas en Tiempo Real</h4>
              <p>Ve estadísticas de compresión y tokens ahorrados en cada análisis.</p>
            </div>
          </div>
          
          <div className={styles.exampleSection}>
            <h4>Ejemplo de Optimización:</h4>
            <div className={styles.exampleGrid}>
              <div className={styles.exampleBefore}>
                <h5>Antes (Email Original)</h5>
                <code className={styles.exampleCode}>
                  Hola, estoy interesado en sus servicios.<br/><br/>
                  --<br/>
                  Juan Pérez<br/>
                  Director de Ventas<br/>
                  Empresa XYZ<br/>
                  Tel: +1-555-123-4567<br/>
                  Email: juan@empresa.com<br/><br/>
                  CONFIDENCIAL: Este email es confidencial...
                </code>
                <span className={styles.tokenCount}>~150 tokens</span>
              </div>
              
              <div className={styles.exampleArrow}>→</div>
              
              <div className={styles.exampleAfter}>
                <h5>Después (Texto Optimizado)</h5>
                <code className={styles.exampleCode}>
                  Hola, estoy interesado en sus servicios.
                </code>
                <span className={styles.tokenCount}>~12 tokens</span>
              </div>
            </div>
            <div className={styles.savingsHighlight}>
              💡 <strong>Ahorro: ~92% menos tokens</strong>
            </div>
          </div>
        </div>
      )}

      <UnifiedApiTester
        apiId="email_agent"
        title={title}
        description={description}
        defaultEndpoint="/api/agents/email"
        defaultMethod="POST"
        showModelOptions={false}
        additionalFields={[
          {
            id: 'optimization_enabled',
            label: 'Optimización de Texto Habilitada ✨',
            type: 'info',
            value: 'La optimización está activa por defecto. Los emails serán procesados automáticamente para reducir tokens innecesarios.',
            readOnly: true
          }
        ]}
      />

      {showOptimizationInfo && (
        <div className={styles.optimizationTips}>
          <h4>💡 Consejos para Mejores Resultados:</h4>
          <ul>
            <li><strong>Emails largos:</strong> La optimización es más efectiva con emails que incluyen firmas extensas o disclaimers.</li>
            <li><strong>Conversaciones:</strong> Los emails de respuesta con texto citado se optimizan significativamente.</li>
            <li><strong>Emails corporativos:</strong> Especialmente útil para emails con footers legales largos.</li>
            <li><strong>Monitoreo:</strong> Revisa las métricas de compresión en la respuesta para ver el ahorro real.</li>
          </ul>
        </div>
      )}
    </div>
  );
};

export default EmailOptimizationTester; 