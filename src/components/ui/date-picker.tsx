'use client';

import React from 'react';

interface DatePickerProps {
  value?: string | null;
  onChange: (value: string | null) => void;
  name: string;
  placeholder?: string;
}

export const DatePicker: React.FC<DatePickerProps> = ({ 
  value,
  onChange,
  name,
  placeholder = "Seleccionar fecha" 
}) => {
  // Estado local para manejar el valor del input
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  if (!mounted) {
    return null; // O un placeholder si lo prefieres
  }

  return (
    <input
      type="date"
      name={name}
      value={value?.slice(0, 10) || ''}
      onChange={(e) => {
        const date = e.target.value;
        onChange(date ? new Date(date + 'T00:00:00Z').toISOString() : null);
      }}
      className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      placeholder={placeholder}
    />
  );
}; 