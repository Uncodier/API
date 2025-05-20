'use client';

import React from 'react';
import styles from '../../ApiTester.module.css';

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
            readOnly={readOnly}
          />
          <label htmlFor={id}>{label}</label>
        </div>
      )}
    </div>
  );
};

// Componente para renderizar una etiqueta de sección
export const SectionLabel = ({ children }: { children: React.ReactNode }) => {
  return (
    <label className={styles.sectionLabel}>
      {children}
    </label>
  );
}; 