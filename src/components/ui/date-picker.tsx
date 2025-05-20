'use client';

import React from 'react';
import { Control, Controller } from 'react-hook-form';
import { useEffect, useState } from 'react';

interface DatePickerProps {
  control: Control<any>;
  name: string;
  placeholder?: string;
}

export const DatePicker: React.FC<DatePickerProps> = ({ 
  control, 
  name,
  placeholder = "Seleccionar fecha" 
}) => {
  // Estado local para manejar el valor del input
  const [mounted, setMounted] = useState(false);

  // Solo renderizar después de montar para evitar problemas de hidratación
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null; // O un placeholder si lo prefieres
  }

  return (
    <Controller
      control={control}
      name={name}
      render={({ field: { onChange, value } }) => (
        <input
          type="date"
          value={value || ''}
          onChange={(e) => {
            const date = e.target.value;
            if (date) {
              // Convertir la fecha a ISO string con hora 00:00:00
              const isoDate = new Date(date + 'T00:00:00Z').toISOString();
              onChange(isoDate);
            } else {
              onChange(null);
            }
          }}
          className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder={placeholder}
        />
      )}
    />
  );
}; 