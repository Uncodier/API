'use client';

import React, { useState } from 'react';
import { codeExamples } from '../types';
import { highlightCode } from '../utilsComponents';
import styles from '../../ApiTester.module.css';
import { SectionLabel } from '../utilsComponents';

interface ApiImplementationProps {
  requestBody: any;
  method: string;
  endpoint: string;
  headers?: Record<string, string>;
}

const ApiImplementation: React.FC<ApiImplementationProps> = ({ 
  requestBody, 
  method, 
  endpoint,
  headers = { 'Content-Type': 'application/json' }
}) => {
  const [codeLanguage, setCodeLanguage] = useState<'curl' | 'javascript' | 'python' | 'php'>('curl');
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const code = codeExamples[codeLanguage](requestBody, method, endpoint, headers);
    
    try {
      // Try modern clipboard API first
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        // Fallback to older method
        const textArea = document.createElement('textarea');
        textArea.value = code;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
      // You could set an error state here if needed
    }
  };

  return (
    <div className={styles.innerCard}>
      <h3 className={styles.implementationTitle}>Implementation</h3>
      
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
            className={`${styles.mainTabButton} ${codeLanguage === 'curl' ? styles.mainActiveTab : ''}`}
            onClick={() => setCodeLanguage('curl')}
          >
            cURL
          </button>
          <button 
            className={`${styles.mainTabButton} ${codeLanguage === 'javascript' ? styles.mainActiveTab : ''}`}
            onClick={() => setCodeLanguage('javascript')}
          >
            JavaScript
          </button>
          <button 
            className={`${styles.mainTabButton} ${codeLanguage === 'python' ? styles.mainActiveTab : ''}`}
            onClick={() => setCodeLanguage('python')}
          >
            Python
          </button>
          <button 
            className={`${styles.mainTabButton} ${codeLanguage === 'php' ? styles.mainActiveTab : ''}`}
            onClick={() => setCodeLanguage('php')}
          >
            PHP
          </button>
        </div>
      </div>
      
      <div className={styles.codeBlock}>
        <button 
          className={styles.copyButton} 
          onClick={handleCopy}
          aria-label="Copy code"
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
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
        <pre 
          style={{ margin: 0 }}
          dangerouslySetInnerHTML={{ 
            __html: highlightCode(
              codeExamples[codeLanguage](requestBody, method, endpoint, headers),
              codeLanguage
            ) 
          }} 
        />
      </div>
    </div>
  );
};

export default ApiImplementation; 