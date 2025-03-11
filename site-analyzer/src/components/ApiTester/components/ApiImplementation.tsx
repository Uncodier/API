'use client';

import React, { useState } from 'react';
import { codeExamples } from '../types';
import { highlightCode } from '../utils';
import styles from '../../ApiTester.module.css';

interface ApiImplementationProps {
  requestBody: any;
  method: string;
  endpoint: string;
}

const ApiImplementation: React.FC<ApiImplementationProps> = ({ requestBody, method, endpoint }) => {
  const [codeLanguage, setCodeLanguage] = useState<'curl' | 'javascript' | 'python' | 'php'>('curl');
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const code = codeExamples[codeLanguage](requestBody, method, endpoint);
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.innerCard}>
      <h3 className={styles.implementationTitle}>Implementación</h3>
      
      <div className={styles.callout}>
        <div className={styles.calloutContent}>
          <p>
            <span className={styles.calloutText}>Endpoint: </span>
            <span className={styles.methodBadge}>{method}</span>
            <code className={styles.endpointCode}>{endpoint}</code>
          </p>
        </div>
      </div>
      
      <div className={styles.techTabsContainer}>
        <div className={styles.techTabs}>
          <button 
            className={`${styles.techTabButton} ${codeLanguage === 'curl' ? styles.activeTechTab : ''}`}
            onClick={() => setCodeLanguage('curl')}
          >
            <span className={styles.techTabIcon}>$</span>
            cURL
          </button>
          <button 
            className={`${styles.techTabButton} ${codeLanguage === 'javascript' ? styles.activeTechTab : ''}`}
            onClick={() => setCodeLanguage('javascript')}
          >
            <span className={styles.techTabIcon}>JS</span>
            JavaScript
          </button>
          <button 
            className={`${styles.techTabButton} ${codeLanguage === 'python' ? styles.activeTechTab : ''}`}
            onClick={() => setCodeLanguage('python')}
          >
            <span className={styles.techTabIcon}>PY</span>
            Python
          </button>
          <button 
            className={`${styles.techTabButton} ${codeLanguage === 'php' ? styles.activeTechTab : ''}`}
            onClick={() => setCodeLanguage('php')}
          >
            <span className={styles.techTabIcon}>PHP</span>
            PHP
          </button>
        </div>
      </div>
      
      <div className={styles.codeBlock}>
        <button 
          className={styles.copyButton} 
          onClick={handleCopy}
          aria-label="Copiar código"
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
        <pre 
          style={{ margin: 0 }}
          dangerouslySetInnerHTML={{ 
            __html: highlightCode(
              codeExamples[codeLanguage](requestBody, method, endpoint),
              codeLanguage
            ) 
          }} 
        />
      </div>
    </div>
  );
};

export default ApiImplementation; 