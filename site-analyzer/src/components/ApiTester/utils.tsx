import React from 'react';
import styles from '../ApiTester.module.css';

// Función para formatear JSON con resaltado de sintaxis mejorado
export const formatJsonWithSyntax = (json: any) => {
  try {
    // Asegurarse de que el JSON esté bien formateado
    const jsonString = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
    
    // Aplicar resaltado de sintaxis con colores más profesionales
    return jsonString.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = styles.number;
      
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = styles.key;
        } else {
          cls = styles.string;
        }
      } else if (/true|false/.test(match)) {
        cls = styles.boolean;
      } else if (/null/.test(match)) {
        cls = styles.null;
      }
      
      return `<span class="${cls}">${match}</span>`;
    })
    // Añadir indentación visual con espacios no rompibles
    .replace(/\n  /g, '\n<span class="indent"></span>')
    // Resaltar corchetes y llaves
    .replace(/[{}\[\]]/g, (match) => `<span class="${styles.bracket}">${match}</span>`);
  } catch (error) {
    console.error('Error formatting JSON:', error);
    return typeof json === 'string' ? json : JSON.stringify(json, null, 2);
  }
};

// Función simple para escapar HTML
export const escapeHtml = (text: string) => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

// Función para resaltar código
export const highlightCode = (code: string, language: 'curl' | 'javascript' | 'python' | 'php') => {
  let escapedCode = escapeHtml(code);
  
  // Resaltado básico para comentarios
  if (language === 'curl' || language === 'python') {
    // Resaltar comentarios que comienzan con #
    escapedCode = escapedCode.replace(
      /(^|\n)(#.*)$/gm, 
      '$1<span style="color: #6a9955; font-style: italic;">$2</span>'
    );
  }
  
  if (language === 'javascript' || language === 'php') {
    // Resaltar comentarios que comienzan con //
    escapedCode = escapedCode.replace(
      /(^|\n)(\/\/.*)$/gm, 
      '$1<span style="color: #6a9955; font-style: italic;">$2</span>'
    );
  }
  
  // Resaltar strings
  escapedCode = escapedCode.replace(
    /"([^"]*)"/g, 
    '<span style="color: #ce9178;">"$1"</span>'
  );
  
  // Resaltar palabras clave según el lenguaje
  const keywords = {
    curl: ['curl', '-X', '-H', '-d'],
    javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'try', 'catch', 'await', 'async'],
    python: ['import', 'from', 'def', 'class', 'if', 'else', 'try', 'except', 'as', 'with', 'for', 'in'],
    php: ['function', 'if', 'else', 'try', 'catch', 'foreach', 'while', 'echo', 'print', 'return']
  };
  
  // Aplicar resaltado de palabras clave
  keywords[language].forEach(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'g');
    escapedCode = escapedCode.replace(
      regex, 
      `<span style="color: #569cd6; font-weight: bold;">${keyword}</span>`
    );
  });
  
  return escapedCode;
};

// Función para resaltar JSON
export const highlightJson = (json: string) => {
  // Primero asegurarse de que el JSON esté bien formateado con indentación
  try {
    const parsedJson = JSON.parse(json);
    json = JSON.stringify(parsedJson, null, 2);
  } catch (e) {
    // Si no es un JSON válido, mantener el original
  }
  
  // Reemplazar con regex para añadir spans con clases apropiadas
  return json
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = 'number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'key';
        } else {
          cls = 'string';
        }
      } else if (/true|false/.test(match)) {
        cls = 'boolean';
      } else if (/null/.test(match)) {
        cls = 'null';
      }
      return `<span class="${styles[cls]}">${match}</span>`;
    });
};

// Componente para renderizar un badge de estado
export const StatusBadge = ({ code, text }: { code: number, text: string }) => {
  let badgeClass = '';
  
  if (code >= 200 && code < 300) {
    badgeClass = styles.successBadge;
  } else if (code >= 400 && code < 500) {
    badgeClass = styles.warningBadge;
  } else if (code >= 500) {
    badgeClass = styles.serverErrorBadge;
  } else {
    badgeClass = styles.infoBadge;
  }
  
  return (
    <span className={`${styles.statusBadge} ${badgeClass}`}>
      {code}
    </span>
  );
};

// Componente para renderizar un campo de formulario
export const FormField = ({ 
  label, 
  id, 
  type = 'text', 
  value, 
  onChange, 
  placeholder = '', 
  options = [], 
  rows = 4,
  min,
  max,
  required = false,
  disabled = false,
  readOnly = false
}: {
  label: string;
  id: string;
  type?: 'text' | 'textarea' | 'select' | 'checkbox' | 'number';
  value: any;
  onChange: (value: any) => void;
  placeholder?: string;
  options?: { value: string; label: string }[];
  rows?: number;
  min?: number;
  max?: number;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
}) => {
  return (
    <div className={styles.formGroup}>
      {type !== 'checkbox' && (
        <label htmlFor={id}>
          {label}
          {required && <span className={styles.required}>*</span>}
        </label>
      )}
      
      {type === 'text' && (
        <input
          type="text"
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={styles.formControl}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
        />
      )}
      
      {type === 'textarea' && (
        <textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={styles.formControl}
          placeholder={placeholder}
          rows={rows}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
        />
      )}
      
      {type === 'select' && (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={styles.formControl}
          required={required}
          disabled={disabled}
        >
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      
      {type === 'number' && (
        <input
          type="number"
          id={id}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={styles.formControl}
          placeholder={placeholder}
          min={min}
          max={max}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
        />
      )}
      
      {type === 'checkbox' && (
        <div className={styles.checkboxWrapper}>
          <input
            type="checkbox"
            id={id}
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className={styles.checkbox}
            required={required}
            disabled={disabled}
          />
          <label htmlFor={id} className={styles.checkboxLabel}>
            <span className={styles.checkboxText}>{label}</span>
          </label>
        </div>
      )}
    </div>
  );
}; 