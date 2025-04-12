// Importamos las APIs
import './apis';

// Exportamos el componente principal
import UnifiedApiTester, { UnifiedApiTesterProps } from './UnifiedApiTester';

// Exportamos los componentes modulares
import ApiResults from './components/ApiResults';
import ApiImplementation from './components/ApiImplementation';

// Re-exportamos los componentes de utilidades
import { FormField, SectionLabel } from './utils';

// Exportación por defecto
export default UnifiedApiTester;

// Exportaciones nombradas
export { 
  UnifiedApiTester,
  ApiResults,
  ApiImplementation,
  FormField,
  SectionLabel
};

// Exportaciones de tipos
export type { 
  UnifiedApiTesterProps
}; 