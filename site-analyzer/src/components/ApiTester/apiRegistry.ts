import { BaseApiConfig } from './types';

// Clase para el registro de APIs
class ApiRegistry {
  private apis: Map<string, BaseApiConfig> = new Map();

  // Registrar una nueva API
  register(api: BaseApiConfig): void {
    if (this.apis.has(api.id)) {
      console.warn(`API con ID '${api.id}' ya está registrada. Será sobrescrita.`);
    }
    this.apis.set(api.id, api);
  }

  // Obtener una API por su ID
  get(id: string): BaseApiConfig | undefined {
    return this.apis.get(id);
  }

  // Obtener todas las APIs registradas
  getAll(): BaseApiConfig[] {
    return Array.from(this.apis.values());
  }

  // Verificar si una API está registrada
  has(id: string): boolean {
    return this.apis.has(id);
  }
}

// Crear una instancia del registro
const apiRegistry = new ApiRegistry();

export default apiRegistry; 