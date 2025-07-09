-- Crear función para incrementar sesiones de visitante
CREATE OR REPLACE FUNCTION increment_visitor_sessions(
    visitor_id UUID,
    last_seen_timestamp BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE visitors 
    SET 
        total_sessions = COALESCE(total_sessions, 0) + 1,
        last_seen_at = last_seen_timestamp,
        updated_at = NOW()
    WHERE id = visitor_id;
    
    -- Si no se actualizó ninguna fila, significa que el visitante no existe
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Visitante no encontrado con ID: %', visitor_id;
    END IF;
END;
$$; 