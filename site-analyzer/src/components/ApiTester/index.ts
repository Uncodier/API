// Importamos las APIs
import './apis';

// Exportamos el componente principal
import UnifiedApiTester, { UnifiedApiTesterProps } from './UnifiedApiTester';

// Exportamos los componentes modulares
import ApiResults from './components/ApiResults';
import ApiImplementation from './components/ApiImplementation';

// Exportación por defecto
export default UnifiedApiTester;

// Exportaciones nombradas
export { 
  UnifiedApiTester,
  ApiResults,
  ApiImplementation
};

// Exportaciones de tipos
export type { 
  UnifiedApiTesterProps
}; 