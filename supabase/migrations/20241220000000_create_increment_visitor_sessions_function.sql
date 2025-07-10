-- Crear función para incrementar sesiones de visitantes
-- Esta función incrementa el contador de sesiones totales de un visitante
-- y actualiza su última fecha de visita

CREATE OR REPLACE FUNCTION public.increment_visitor_sessions(
    visitor_id UUID,
    last_seen_timestamp BIGINT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Actualizar el visitante existente incrementando total_sessions
    UPDATE public.visitors 
    SET 
        total_sessions = COALESCE(total_sessions, 0) + 1,
        last_seen_at = last_seen_timestamp,
        updated_at = NOW()
    WHERE id = visitor_id;
    
    -- Si no se actualizó ninguna fila, significa que el visitante no existe
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Visitor with ID % not found', visitor_id;
    END IF;
END;
$$;

-- Dar permisos de ejecución
GRANT EXECUTE ON FUNCTION public.increment_visitor_sessions(UUID, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_visitor_sessions(UUID, BIGINT) TO anon;

-- Comentario sobre la función
COMMENT ON FUNCTION public.increment_visitor_sessions(UUID, BIGINT) IS 
'Incrementa el contador de sesiones totales de un visitante y actualiza su última fecha de visita'; 