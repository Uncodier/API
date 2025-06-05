/**
 * Test suite para la transformación de fechas en CreateTask API
 */

// Función copiada del archivo route.ts para testing
function transformToISO8601(dateInput: any): string | null {
  if (!dateInput) return null;
  
  try {
    // Si ya es un string que parece ISO 8601, validarlo
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }

    // Si es un número (timestamp)
    if (typeof dateInput === 'number') {
      // Si parece timestamp en segundos (menos de año 2050 en ms)
      const timestamp = dateInput < 2524608000 ? dateInput * 1000 : dateInput;
      const date = new Date(timestamp);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }

    // Si es un string, intentar diferentes formatos
    if (typeof dateInput === 'string') {
      let dateStr = dateInput.trim();
      
      // Verificar si es una fecha claramente inválida
      if (dateStr.match(/[a-zA-Z]/) && !dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) {
        // Si contiene letras pero no es un formato de fecha conocido, retornar null
        return null;
      }
      
      // Manejar formatos comunes con regex más específicos
      const formats = [
        // YYYY-MM-DD o YYYY/MM/DD
        {
          regex: /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'ymd'
        },
        // DD/MM/YYYY o DD-MM-YYYY (día > 12)
        {
          regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'dmy',
          condition: (parts: string[]) => parseInt(parts[0]) > 12
        },
        // MM/DD/YYYY o MM-DD-YYYY (mes > 12)
        {
          regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'mdy',
          condition: (parts: string[]) => parseInt(parts[1]) > 12
        },
        // DD/MM/YYYY o DD-MM-YYYY (por defecto)
        {
          regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'dmy'
        }
      ];

      // Intentar con Date constructor primero para formatos estándar
      let date = new Date(dateStr);
      if (!isNaN(date.getTime()) && dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) {
        return date.toISOString();
      }

      // Intentar parsear manualmente formatos específicos
      for (const format of formats) {
        const match = dateStr.match(format.regex);
        if (match) {
          const [, part1, part2, part3, , hour, minute, , second] = match;
          
          // Verificar condición si existe
          if (format.condition && !format.condition([part1, part2, part3])) {
            continue;
          }
          
          let day: number, month: number, year: number;
          
          switch (format.order) {
            case 'ymd':
              year = parseInt(part1);
              month = parseInt(part2);
              day = parseInt(part3);
              break;
            case 'mdy':
              month = parseInt(part1);
              day = parseInt(part2);
              year = parseInt(part3);
              break;
            case 'dmy':
            default:
              day = parseInt(part1);
              month = parseInt(part2);
              year = parseInt(part3);
              break;
          }

          // Validar rangos
          if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) {
            continue;
          }

          // Construir fecha en UTC para evitar problemas de zona horaria
          const h = hour ? parseInt(hour) : 0;
          const m = minute ? parseInt(minute) : 0;
          const s = second ? parseInt(second) : 0;
          
          // Usar UTC para evitar conversiones de zona horaria
          date = new Date(Date.UTC(year, month - 1, day, h, m, s));
          
          if (!isNaN(date.getTime())) {
            return date.toISOString();
          }
        }
      }
    }

    // Último intento: usar Date constructor directamente solo si no contiene letras problemáticas
    if (typeof dateInput === 'string' && !dateInput.match(/[a-zA-Z]/) || 
        (typeof dateInput === 'string' && dateInput.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i))) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }

    return null;
    
  } catch (error) {
    console.warn('Error transformando fecha:', dateInput, error);
    return null;
  }
}

describe('Transformación de fechas - CreateTask API', () => {
  
  test('transforma fecha DD/MM/YYYY a ISO 8601', () => {
    const result = transformToISO8601('15/12/2023 14:30');
    expect(result).toBe('2023-12-15T14:30:00.000Z');
  });

  test('transforma fecha DD/MM/YYYY sin hora a ISO 8601', () => {
    const result = transformToISO8601('15/12/2023');
    expect(result).toBe('2023-12-15T00:00:00.000Z');
  });

  test('transforma timestamp Unix en segundos a ISO 8601', () => {
    const result = transformToISO8601(1702648800); // 15 Dec 2023 14:00:00 UTC
    expect(result).toBe('2023-12-15T14:00:00.000Z');
  });

  test('transforma timestamp Unix en milisegundos a ISO 8601', () => {
    const result = transformToISO8601(1702648800000); // 15 Dec 2023 14:00:00 UTC
    expect(result).toBe('2023-12-15T14:00:00.000Z');
  });

  test('mantiene fecha ISO 8601 válida', () => {
    const isoDate = '2023-12-15T14:00:00.000Z';
    const result = transformToISO8601(isoDate);
    expect(result).toBe(isoDate);
  });

  test('retorna null para fecha inválida', () => {
    const result = transformToISO8601('fecha-invalida-123');
    expect(result).toBe(null);
  });

  test('transforma fecha YYYY-MM-DD con hora', () => {
    const result = transformToISO8601('2023-12-15 14:30:45');
    expect(result).toBe('2023-12-15T14:30:45.000Z');
  });

  test('transforma formato MM/DD/YYYY cuando el día es mayor a 12', () => {
    const result = transformToISO8601('03/25/2023'); // Claramente MM/DD/YYYY
    expect(result).toBe('2023-03-25T00:00:00.000Z');
  });

  test('asume DD/MM/YYYY por defecto en casos ambiguos', () => {
    const result = transformToISO8601('05/03/2023'); // Ambiguo, asume DD/MM/YYYY
    expect(result).toBe('2023-03-05T00:00:00.000Z');
  });

  test('maneja fechas con guiones', () => {
    const result = transformToISO8601('15-12-2023 10:30');
    expect(result).toBe('2023-12-15T10:30:00.000Z');
  });

  test('retorna null para valores null, undefined o vacíos', () => {
    expect(transformToISO8601(null)).toBe(null);
    expect(transformToISO8601(undefined)).toBe(null);
    expect(transformToISO8601('')).toBe(null);
  });

  test('maneja formato de fecha natural en inglés', () => {
    const result = transformToISO8601('Dec 15, 2023');
    expect(result).not.toBe(null);
    expect(result).toMatch(/^2023-12-15T/);
  });

  test('valida que fecha ISO 8601 inválida retorna null', () => {
    const result = transformToISO8601('2023-13-45T25:70:80.000Z'); // Fecha imposible
    expect(result).toBe(null);
  });

  test('maneja correctamente timestamp con valor correcto', () => {
    // Usar un timestamp que sabemos que es correcto: 1 Jan 2024 00:00:00 UTC
    const result = transformToISO8601(1704067200); // 1 Jan 2024 00:00:00 UTC
    expect(result).toBe('2024-01-01T00:00:00.000Z');
  });

}); 