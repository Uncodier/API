import { z } from 'zod';

// Esquema base para direcciones/locaciones (estructura común)
const BaseLocationSchema = z.object({
  zip: z.string().optional(),
  city: z.string().optional(),
  name: z.string().optional(),
  state: z.string().optional(),
  address: z.string().optional(),
  country: z.string().optional(),
});

// Esquema de validación para el objeto restrictions
// Las direcciones excluidas/incluidas usan la misma estructura que las locaciones principales
const RestrictionsSchema = z.object({
  enabled: z.boolean().default(false),
  excluded_addresses: z.array(BaseLocationSchema).default([]),
  included_addresses: z.array(BaseLocationSchema).default([]),
});

// Función para limpiar y formatear ubicaciones
function formatLocations(locations: any[]): any[] {
  return locations.map(location => {
    // Función helper para limpiar objetos de valores vacíos
    const cleanObject = (obj: any) => {
      const cleaned: any = {};
      Object.keys(obj).forEach(key => {
        const value = obj[key];
        if (value !== null && value !== undefined && value !== '') {
          if (Array.isArray(value)) {
            const cleanedArray = value.map(item => cleanObject(item)).filter(item => Object.keys(item).length > 0);
            if (cleanedArray.length > 0) {
              cleaned[key] = cleanedArray;
            }
          } else if (typeof value === 'object') {
            const cleanedNestedObj = cleanObject(value);
            if (Object.keys(cleanedNestedObj).length > 0) {
              cleaned[key] = cleanedNestedObj;
            }
          } else {
            cleaned[key] = value;
          }
        }
      });
      return cleaned;
    };

    // Limpiar la ubicación principal
    const cleanedLocation = cleanObject(location);

    // Procesar restricciones con nueva nomenclatura
    if (cleanedLocation.restrictions) {
      const restrictions = cleanedLocation.restrictions;
      const newRestrictions: any = {
        enabled: restrictions.enabled
      };

      // Cambiar nomenclatura y limpiar arrays
      if (restrictions.included_addresses && restrictions.included_addresses.length > 0) {
        const cleanedIncluded = restrictions.included_addresses.map((addr: any) => cleanObject(addr)).filter((addr: any) => Object.keys(addr).length > 0);
        if (cleanedIncluded.length > 0) {
          newRestrictions.service_only_available_in = cleanedIncluded;
        }
      }

      if (restrictions.excluded_addresses && restrictions.excluded_addresses.length > 0) {
        const cleanedExcluded = restrictions.excluded_addresses.map((addr: any) => cleanObject(addr)).filter((addr: any) => Object.keys(addr).length > 0);
        if (cleanedExcluded.length > 0) {
          newRestrictions.service_excluded_in = cleanedExcluded;
        }
      }

      // Solo agregar restrictions si tiene contenido útil
      if (Object.keys(newRestrictions).length > 1) { // más que solo 'enabled'
        cleanedLocation.restrictions = newRestrictions;
      } else {
        delete cleanedLocation.restrictions;
      }
    }

    return cleanedLocation;
  });
}

// Esquema de validación para cada location (extiende la estructura base + restrictions)
const LocationSchema = BaseLocationSchema.extend({
  restrictions: RestrictionsSchema.optional(),
});

export function formatSiteLocations(settings: any): string {
  let siteSection = '';
  // Ubicaciones con procesamiento de restrictions
  if (settings.locations) {
    // Reduced verbosity

    try {
      // Parsear locations si es string
      const locationsData = typeof settings.locations === 'string'
        ? JSON.parse(settings.locations)
        : settings.locations;

      // Validar y procesar cada location
      const processedLocations = Array.isArray(locationsData)
        ? locationsData.map((location, index) => {
            try {
              // Validar la estructura de la location usando el schema
              const validatedLocation = LocationSchema.parse(location);

              // Procesar restrictions si existe (reduced verbosity)
              if (validatedLocation.restrictions) {
                // Location has restrictions - processing silently
              }

              return validatedLocation;
            } catch (validationError) {
              console.warn(`⚠️ [BackgroundBuilder] Error validando location ${index + 1}:`, validationError);
              // Si la validación falla, retornamos la location original pero sin restrictions
              const { restrictions, ...locationWithoutRestrictions } = location;
              return locationWithoutRestrictions;
            }
          })
        : locationsData;

      // Aplicar formateo mejorado (limpia valores vacíos y cambia nomenclatura)
      const formattedLocations = formatLocations(Array.isArray(processedLocations) ? processedLocations : [processedLocations]);

      // Parsear y formatear como texto legible
      siteSection += `\n## Locations\n`;
      formattedLocations.forEach((location, index) => {
        // Información básica de la ubicación
        const locationParts = [];
        if (location.name) locationParts.push(location.name);
        if (location.city) locationParts.push(location.city);
        if (location.state) locationParts.push(location.state);
        if (location.country) locationParts.push(location.country);
        if (location.zip) locationParts.push(`(${location.zip})`);
        if (location.address) locationParts.push(`- ${location.address}`);

        siteSection += `${index + 1}. ${locationParts.join(', ')}\n`;

        // Restricciones de servicio si existen
        if (location.restrictions && location.restrictions.enabled) {
          if (location.restrictions.service_only_available_in && location.restrictions.service_only_available_in.length > 0) {
            siteSection += `   Service only available in: `;
            const availableIn = location.restrictions.service_only_available_in.map((addr: any) => {
              const parts = [];
              if (addr.name) parts.push(addr.name);
              if (addr.city) parts.push(addr.city);
              if (addr.state) parts.push(addr.state);
              if (addr.country) parts.push(addr.country);
              return parts.join(', ');
            }).filter((part: string) => part.length > 0);
            siteSection += `${availableIn.join('; ')}\n`;
          }

          if (location.restrictions.service_excluded_in && location.restrictions.service_excluded_in.length > 0) {
            siteSection += `   Service excluded in: `;
            const excludedIn = location.restrictions.service_excluded_in.map((addr: any) => {
              const parts = [];
              if (addr.name) parts.push(addr.name);
              if (addr.city) parts.push(addr.city);
              if (addr.state) parts.push(addr.state);
              if (addr.country) parts.push(addr.country);
              return parts.join(', ');
            }).filter((part: string) => part.length > 0);
            siteSection += `${excludedIn.join('; ')}\n`;
          }
        }

        siteSection += `\n`; // Espacio entre ubicaciones
      });

    } catch (error) {
      console.error(`❌ [BackgroundBuilder] Error procesando locations:`, error);
      siteSection += `\n## Locations\n${JSON.stringify(settings.locations)}\n`;
    }
  }
  return siteSection;
}
