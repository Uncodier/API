import { RegionVenuesService } from '@/services/sales/RegionVenuesService';

// Mock para Google Maps API
const mockGoogleResponse = {
  status: 'OK',
  results: [
    {
      place_id: 'ChIJtest1',
      name: 'McDonald\'s',
      formatted_address: 'Test Address 1',
      geometry: { location: { lat: 40.4168, lng: -3.7038 } },
      types: ['restaurant'],
      rating: 4.0
    },
    {
      place_id: 'ChIJtest2',
      name: 'Burger King',
      formatted_address: 'Test Address 2',
      geometry: { location: { lat: 40.4169, lng: -3.7039 } },
      types: ['restaurant'],
      rating: 3.5
    },
    {
      place_id: 'ChIJtest3',
      name: 'Pizza Hut',
      formatted_address: 'Test Address 3',
      geometry: { location: { lat: 40.4170, lng: -3.7040 } },
      types: ['restaurant'],
      rating: 4.2
    },
    {
      place_id: 'ChIJtest4',
      name: 'Local Restaurant',
      formatted_address: 'Test Address 4',
      geometry: { location: { lat: 40.4171, lng: -3.7041 } },
      types: ['restaurant'],
      rating: 4.8
    }
  ]
};

// Mock del fetch para Google API
global.fetch = jest.fn();

describe('RegionVenuesService - Exclusion Functionality', () => {
  let service: RegionVenuesService;

  beforeEach(() => {
    // Mock de las variables de entorno
    process.env.GOOGLE_CLOUD_API_KEY = 'test_api_key';
    
    // Configurar el mock de fetch
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('geocode')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            status: 'OK',
            results: [
              {
                geometry: {
                  location: { lat: 40.4168, lng: -3.7038 }
                }
              }
            ]
          })
        });
      }
      
      if (url.includes('nearbysearch')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockGoogleResponse)
        });
      }
      
      if (url.includes('details')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            status: 'OK',
            result: {
              formatted_phone_number: '+34 123 456 789',
              website: 'https://example.com',
              business_status: 'OPERATIONAL',
              rating: 4.0,
              user_ratings_total: 100,
              types: ['restaurant']
            }
          })
        });
      }
      
      return Promise.resolve({
        ok: false,
        status: 404
      });
    });
    
    service = new RegionVenuesService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('should exclude venues by Place ID', async () => {
    const result = await service.searchRegionVenues({
      siteId: 'test-site',
      searchTerm: 'restaurants',
      city: 'Madrid',
      region: 'Madrid',
      limit: 10,
      excludeVenues: {
        placeIds: ['ChIJtest1', 'ChIJtest2'] // Excluir McDonald's y Burger King
      }
    });

    expect(result.success).toBe(true);
    expect(result.venues).toBeDefined();
    expect(result.venues!.length).toBe(2); // Solo Pizza Hut y Local Restaurant
    
    const venueNames = result.venues!.map(v => v.name);
    expect(venueNames).not.toContain('McDonald\'s');
    expect(venueNames).not.toContain('Burger King');
    expect(venueNames).toContain('Pizza Hut');
    expect(venueNames).toContain('Local Restaurant');
  });

  test('should exclude venues by name (case-insensitive)', async () => {
    const result = await service.searchRegionVenues({
      siteId: 'test-site',
      searchTerm: 'restaurants',
      city: 'Madrid',
      region: 'Madrid',
      limit: 10,
      excludeVenues: {
        names: ['mcdonald\'s', 'PIZZA HUT'] // Diferentes casos
      }
    });

    expect(result.success).toBe(true);
    expect(result.venues).toBeDefined();
    expect(result.venues!.length).toBe(2); // Solo Burger King y Local Restaurant
    
    const venueNames = result.venues!.map(v => v.name);
    expect(venueNames).not.toContain('McDonald\'s');
    expect(venueNames).not.toContain('Pizza Hut');
    expect(venueNames).toContain('Burger King');
    expect(venueNames).toContain('Local Restaurant');
  });

  test('should exclude venues by both Place ID and name', async () => {
    const result = await service.searchRegionVenues({
      siteId: 'test-site',
      searchTerm: 'restaurants',
      city: 'Madrid',
      region: 'Madrid',
      limit: 10,
      excludeVenues: {
        placeIds: ['ChIJtest1'], // Excluir McDonald's por Place ID
        names: ['Pizza Hut'] // Excluir Pizza Hut por nombre
      }
    });

    expect(result.success).toBe(true);
    expect(result.venues).toBeDefined();
    expect(result.venues!.length).toBe(2); // Solo Burger King y Local Restaurant
    
    const venueNames = result.venues!.map(v => v.name);
    expect(venueNames).not.toContain('McDonald\'s');
    expect(venueNames).not.toContain('Pizza Hut');
    expect(venueNames).toContain('Burger King');
    expect(venueNames).toContain('Local Restaurant');
  });

  test('should return all venues when no exclusions are provided', async () => {
    const result = await service.searchRegionVenues({
      siteId: 'test-site',
      searchTerm: 'restaurants',
      city: 'Madrid',
      region: 'Madrid',
      limit: 10
    });

    expect(result.success).toBe(true);
    expect(result.venues).toBeDefined();
    expect(result.venues!.length).toBe(4); // Todos los venues
    
    const venueNames = result.venues!.map(v => v.name);
    expect(venueNames).toContain('McDonald\'s');
    expect(venueNames).toContain('Burger King');
    expect(venueNames).toContain('Pizza Hut');
    expect(venueNames).toContain('Local Restaurant');
  });

  test('should handle empty exclusion arrays', async () => {
    const result = await service.searchRegionVenues({
      siteId: 'test-site',
      searchTerm: 'restaurants',
      city: 'Madrid',
      region: 'Madrid',
      limit: 10,
      excludeVenues: {
        placeIds: [],
        names: []
      }
    });

    expect(result.success).toBe(true);
    expect(result.venues).toBeDefined();
    expect(result.venues!.length).toBe(4); // Todos los venues
  });

  test('should handle exclusion of non-existent venues', async () => {
    const result = await service.searchRegionVenues({
      siteId: 'test-site',
      searchTerm: 'restaurants',
      city: 'Madrid',
      region: 'Madrid',
      limit: 10,
      excludeVenues: {
        placeIds: ['ChIJnonexistent'],
        names: ['Non-existent Restaurant']
      }
    });

    expect(result.success).toBe(true);
    expect(result.venues).toBeDefined();
    expect(result.venues!.length).toBe(4); // Todos los venues (no se excluye nada)
  });

  test('should respect limit even after exclusions', async () => {
    const result = await service.searchRegionVenues({
      siteId: 'test-site',
      searchTerm: 'restaurants',
      city: 'Madrid',
      region: 'Madrid',
      limit: 2,
      excludeVenues: {
        placeIds: ['ChIJtest1'] // Excluir McDonald's
      }
    });

    expect(result.success).toBe(true);
    expect(result.venues).toBeDefined();
    expect(result.venues!.length).toBe(2); // Respeta el límite
    
    const venueNames = result.venues!.map(v => v.name);
    expect(venueNames).not.toContain('McDonald\'s');
  });
});

// Test de ejemplo de uso progresivo
describe('RegionVenuesService - Progressive Search Example', () => {
  test('should demonstrate progressive search with exclusion', async () => {
    // Simular datos de ejemplo
    const firstBatchVenues = [
      { id: 'ChIJtest1', name: 'McDonald\'s' },
      { id: 'ChIJtest2', name: 'Burger King' }
    ];
    
    // En una aplicación real, usarías estos IDs para excluir en la siguiente búsqueda
    const excludeParams = {
      placeIds: firstBatchVenues.map(venue => venue.id),
      names: firstBatchVenues.map(venue => venue.name)
    };
    
    expect(excludeParams.placeIds).toEqual(['ChIJtest1', 'ChIJtest2']);
    expect(excludeParams.names).toEqual(['McDonald\'s', 'Burger King']);
    
    // Esto demuestra cómo construir parámetros de exclusión para la siguiente búsqueda
    expect(excludeParams.placeIds.join(',')).toBe('ChIJtest1,ChIJtest2');
    expect(excludeParams.names.join(',')).toBe('McDonald\'s,Burger King');
  });
}); 