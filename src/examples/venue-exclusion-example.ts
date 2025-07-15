/**
 * Ejemplo de uso de exclusión de venues en la API de búsqueda regional
 * 
 * Esta funcionalidad permite excluir venues específicos de los resultados de búsqueda
 * usando Place IDs (más preciso) o nombres de venues.
 */

// Ejemplo 1: Excluir venues por Place ID (recomendado)
const searchWithPlaceIdExclusion = async () => {
  // GET request
  const response = await fetch(`/api/agents/sales/regionVenues?` + new URLSearchParams({
    siteId: 'your-site-id',
    searchTerm: 'restaurantes',
    city: 'Madrid',
    region: 'Comunidad de Madrid',
    maxVenues: '10',
    excludePlaceIds: 'ChIJplace1,ChIJplace2,ChIJplace3' // Separados por comas
  }));

  const data = await response.json();
  console.log('Venues encontrados (excluyendo por Place ID):', data.data.venues);
};

// Ejemplo 2: Excluir venues por nombre
const searchWithNameExclusion = async () => {
  // GET request
  const response = await fetch(`/api/agents/sales/regionVenues?` + new URLSearchParams({
    siteId: 'your-site-id',
    searchTerm: 'restaurantes',
    city: 'Madrid',
    region: 'Comunidad de Madrid',
    maxVenues: '10',
    excludeNames: 'McDonald\'s,Burger King,KFC' // Separados por comas
  }));

  const data = await response.json();
  console.log('Venues encontrados (excluyendo por nombre):', data.data.venues);
};

// Ejemplo 3: Excluir venues por ambos criterios
const searchWithMixedExclusion = async () => {
  // GET request
  const response = await fetch(`/api/agents/sales/regionVenues?` + new URLSearchParams({
    siteId: 'your-site-id',
    searchTerm: 'restaurantes',
    city: 'Madrid',
    region: 'Comunidad de Madrid',
    maxVenues: '10',
    excludePlaceIds: 'ChIJplace1,ChIJplace2',
    excludeNames: 'McDonald\'s,Burger King'
  }));

  const data = await response.json();
  console.log('Venues encontrados (exclusión mixta):', data.data.venues);
};

// Ejemplo 4: POST request con exclusión
const searchWithPostExclusion = async () => {
  const response = await fetch('/api/agents/sales/regionVenues', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      siteId: 'your-site-id',
      searchTerm: 'restaurantes',
      city: 'Madrid',
      region: 'Comunidad de Madrid',
      maxVenues: 10,
      excludeVenues: {
        placeIds: ['ChIJplace1', 'ChIJplace2', 'ChIJplace3'],
        names: ['McDonald\'s', 'Burger King', 'KFC']
      }
    })
  });

  const data = await response.json();
  console.log('Venues encontrados (POST con exclusión):', data.data.venues);
};

// Ejemplo 5: Uso progresivo - buscar venues y excluir los ya procesados
const progressiveSearch = async () => {
  let excludedPlaceIds: string[] = [];
  let allVenues: any[] = [];

  // Primera búsqueda
  const firstSearch = await fetch(`/api/agents/sales/regionVenues?` + new URLSearchParams({
    siteId: 'your-site-id',
    searchTerm: 'restaurantes',
    city: 'Madrid',
    region: 'Comunidad de Madrid',
    maxVenues: '5'
  }));

  const firstData = await firstSearch.json();
  allVenues = [...firstData.data.venues];
  excludedPlaceIds = firstData.data.venues.map((venue: any) => venue.id);

  console.log('Primera búsqueda:', firstData.data.venues.length, 'venues');

  // Segunda búsqueda excluyendo los ya encontrados
  const secondSearch = await fetch(`/api/agents/sales/regionVenues?` + new URLSearchParams({
    siteId: 'your-site-id',
    searchTerm: 'restaurantes',
    city: 'Madrid',
    region: 'Comunidad de Madrid',
    maxVenues: '5',
    excludePlaceIds: excludedPlaceIds.join(',')
  }));

  const secondData = await secondSearch.json();
  allVenues = [...allVenues, ...secondData.data.venues];

  console.log('Segunda búsqueda:', secondData.data.venues.length, 'venues');
  console.log('Total venues únicos:', allVenues.length);
};

// Ejemplo 6: Función helper para construir exclusiones
const buildExclusionParams = (excludeVenues: any[]) => {
  const placeIds = excludeVenues
    .filter(venue => venue.id)
    .map(venue => venue.id);
  
  const names = excludeVenues
    .filter(venue => venue.name)
    .map(venue => venue.name);

  return {
    excludePlaceIds: placeIds.length > 0 ? placeIds.join(',') : undefined,
    excludeNames: names.length > 0 ? names.join(',') : undefined
  };
};

// Ejemplo de uso del helper
const searchWithHelper = async (previousVenues: any[]) => {
  const exclusionParams = buildExclusionParams(previousVenues);
  
  // Filtrar valores undefined antes de crear URLSearchParams
  const params: Record<string, string> = {
    siteId: 'your-site-id',
    searchTerm: 'restaurantes',
    city: 'Madrid',
    region: 'Comunidad de Madrid',
    maxVenues: '10'
  };
  
  if (exclusionParams.excludePlaceIds) {
    params.excludePlaceIds = exclusionParams.excludePlaceIds;
  }
  
  if (exclusionParams.excludeNames) {
    params.excludeNames = exclusionParams.excludeNames;
  }
  
  const queryParams = new URLSearchParams(params);

  const response = await fetch(`/api/agents/sales/regionVenues?${queryParams}`);
  const data = await response.json();
  
  console.log('Venues encontrados con helper:', data.data.venues);
};

export {
  searchWithPlaceIdExclusion,
  searchWithNameExclusion,
  searchWithMixedExclusion,
  searchWithPostExclusion,
  progressiveSearch,
  buildExclusionParams,
  searchWithHelper
}; 