'use client';

import React, { useState, useEffect } from 'react';
import { formatJsonWithSyntax } from '../utils';
import styles from '../../ApiTester.module.css';

interface ApiResultsProps {
  loading: boolean;
  error: string | null;
  apiResponse: any;
}

const ApiResults: React.FC<ApiResultsProps> = ({ loading, error, apiResponse }) => {
  const [copied, setCopied] = useState(false);
  const [responseTime, setResponseTime] = useState<string | null>(null);
  const [statusCode, setStatusCode] = useState<number | null>(null);

  useEffect(() => {
    if (apiResponse) {
      // Simulamos un código de estado y tiempo de respuesta
      // En una implementación real, estos valores vendrían de la respuesta HTTP
      setStatusCode(200); // Ejemplo: 200 OK
      setResponseTime(`${Math.floor(Math.random() * 500 + 100)}ms`); // Tiempo aleatorio entre 100-600ms
    } else {
      setStatusCode(null);
      setResponseTime(null);
    }
  }, [apiResponse]);

  const handleCopy = () => {
    if (!apiResponse) return;
    
    const jsonString = JSON.stringify(apiResponse, null, 2);
    navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderStatusBadge = (code: number) => {
    let badgeClass = styles.infoBadge;
    
    if (code >= 200 && code < 300) {
      badgeClass = styles.successBadge;
    } else if (code >= 400 && code < 500) {
      badgeClass = styles.warningBadge;
    } else if (code >= 500) {
      badgeClass = styles.serverErrorBadge;
    }
    
    return (
      <span className={`${styles.statusBadge} ${badgeClass}`}>
        {code}
      </span>
    );
  };

  return (
    <div className={styles.innerCard}>
      <div className={styles.responseHeader}>
        <h3>Resultados</h3>
        {!loading && !error && apiResponse && (
          <div className={styles.responseInfo}>
            {statusCode && (
              <div className={styles.statusInfo}>
                <span>Estado:</span> {renderStatusBadge(statusCode)}
              </div>
            )}
            {responseTime && (
              <div className={styles.requestTime}>
                <svg 
                  xmlns="http://www.w3.org/2000/svg" 
                  width="14" 
                  height="14" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="currentColor" 
                  strokeWidth="2" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                  className={styles.timeIcon}
                >
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                {responseTime}
              </div>
            )}
            <button 
              className={styles.copyButton} 
              onClick={handleCopy}
              aria-label="Copiar JSON"
            >
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                width="16" 
                height="16" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              >
                {copied ? (
                  <>
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </>
                ) : (
                  <>
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </>
                )}
              </svg>
              <span>{copied ? 'Copiado' : 'Copiar'}</span>
            </button>
          </div>
        )}
      </div>
      
      {error && (
        <div className={styles.errorMessage}>
          <strong>Error:</strong> {error}
        </div>
      )}
      
      {loading && (
        <div className={styles.loadingIndicator}>
          <div className={styles.loadingSpinner}></div>
          <p>Cargando resultados...</p>
        </div>
      )}
      
      {!loading && !error && apiResponse && (
        <div className={styles.jsonResponse}>
          <pre 
            style={{ margin: 0 }}
            dangerouslySetInnerHTML={{ 
              __html: formatJsonWithSyntax(apiResponse) 
            }} 
          />
        </div>
      )}
      
      {!loading && !error && !apiResponse && (
        <p>Aún no hay resultados. Envía una solicitud para ver la respuesta.</p>
      )}
    </div>
  );
};

export default ApiResults; 