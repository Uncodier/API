-- Crear tabla para almacenar búsquedas de venues regionales
CREATE TABLE IF NOT EXISTS region_venue_searches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id TEXT NOT NULL,
    user_id TEXT,
    search_term TEXT NOT NULL,
    city TEXT NOT NULL,
    region TEXT NOT NULL,
    venue_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Crear tabla para almacenar los venues encontrados
CREATE TABLE IF NOT EXISTS region_venues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    search_id UUID NOT NULL REFERENCES region_venue_searches(id) ON DELETE CASCADE,
    venue_id TEXT NOT NULL, -- Google Place ID
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    international_phone TEXT,
    website TEXT,
    google_maps_url TEXT,
    business_status TEXT,
    rating TEXT,
    total_ratings INTEGER,
    price_level INTEGER,
    types TEXT[] DEFAULT '{}',
    location_lat DECIMAL(10, 8),
    location_lng DECIMAL(11, 8),
    opening_hours JSONB,
    amenities TEXT[] DEFAULT '{}',
    description TEXT,
    reviews JSONB,
    photos JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Crear índices para mejorar performance
CREATE INDEX IF NOT EXISTS idx_region_venue_searches_site_id ON region_venue_searches(site_id);
CREATE INDEX IF NOT EXISTS idx_region_venue_searches_user_id ON region_venue_searches(user_id);
CREATE INDEX IF NOT EXISTS idx_region_venue_searches_created_at ON region_venue_searches(created_at);
CREATE INDEX IF NOT EXISTS idx_region_venue_searches_search_term ON region_venue_searches(search_term);
CREATE INDEX IF NOT EXISTS idx_region_venue_searches_city_region ON region_venue_searches(city, region);

CREATE INDEX IF NOT EXISTS idx_region_venues_search_id ON region_venues(search_id);
CREATE INDEX IF NOT EXISTS idx_region_venues_venue_id ON region_venues(venue_id);
CREATE INDEX IF NOT EXISTS idx_region_venues_name ON region_venues(name);
CREATE INDEX IF NOT EXISTS idx_region_venues_location ON region_venues(location_lat, location_lng);
CREATE INDEX IF NOT EXISTS idx_region_venues_created_at ON region_venues(created_at);
CREATE INDEX IF NOT EXISTS idx_region_venues_business_status ON region_venues(business_status);
CREATE INDEX IF NOT EXISTS idx_region_venues_rating ON region_venues(rating);
CREATE INDEX IF NOT EXISTS idx_region_venues_price_level ON region_venues(price_level);

-- Crear trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_region_venue_searches_updated_at
    BEFORE UPDATE ON region_venue_searches
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_region_venues_updated_at
    BEFORE UPDATE ON region_venues
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comentarios para documentar las tablas
COMMENT ON TABLE region_venue_searches IS 'Almacena las búsquedas de venues realizadas por los usuarios';
COMMENT ON TABLE region_venues IS 'Almacena los venues encontrados en cada búsqueda';

COMMENT ON COLUMN region_venue_searches.site_id IS 'ID del sitio que realizó la búsqueda';
COMMENT ON COLUMN region_venue_searches.user_id IS 'ID del usuario que realizó la búsqueda (opcional)';
COMMENT ON COLUMN region_venue_searches.search_term IS 'Término de búsqueda usado';
COMMENT ON COLUMN region_venue_searches.city IS 'Ciudad donde se realizó la búsqueda';
COMMENT ON COLUMN region_venue_searches.region IS 'Región/Estado donde se realizó la búsqueda';
COMMENT ON COLUMN region_venue_searches.venue_count IS 'Número de venues encontrados';

COMMENT ON COLUMN region_venues.venue_id IS 'Google Place ID del venue';
COMMENT ON COLUMN region_venues.name IS 'Nombre del venue';
COMMENT ON COLUMN region_venues.address IS 'Dirección completa del venue';
COMMENT ON COLUMN region_venues.phone IS 'Número de teléfono local del venue';
COMMENT ON COLUMN region_venues.international_phone IS 'Número de teléfono internacional del venue';
COMMENT ON COLUMN region_venues.website IS 'Sitio web del venue';
COMMENT ON COLUMN region_venues.google_maps_url IS 'URL de Google Maps del venue';
COMMENT ON COLUMN region_venues.business_status IS 'Estado del negocio (OPERATIONAL, CLOSED_TEMPORARILY, etc.)';
COMMENT ON COLUMN region_venues.rating IS 'Calificación del venue (como string)';
COMMENT ON COLUMN region_venues.total_ratings IS 'Número total de reseñas';
COMMENT ON COLUMN region_venues.price_level IS 'Nivel de precios (0-4)';
COMMENT ON COLUMN region_venues.types IS 'Tipos de negocio según Google Places';
COMMENT ON COLUMN region_venues.location_lat IS 'Latitud de la ubicación';
COMMENT ON COLUMN region_venues.location_lng IS 'Longitud de la ubicación';
COMMENT ON COLUMN region_venues.opening_hours IS 'Información completa de horarios (JSON)';
COMMENT ON COLUMN region_venues.amenities IS 'Amenidades disponibles';
COMMENT ON COLUMN region_venues.description IS 'Descripción generada del venue';
COMMENT ON COLUMN region_venues.reviews IS 'Primeras 3 reseñas del venue (JSON)';
COMMENT ON COLUMN region_venues.photos IS 'Primeras 3 fotos del venue (JSON)'; 