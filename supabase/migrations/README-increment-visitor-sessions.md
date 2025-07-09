# Migración: Función increment_visitor_sessions

## Problema

El error que estabas viendo:

```
[POST /api/visitors/session] Error al actualizar visitante: {
  code: '22P02',
  details: null,
  hint: null,
  message: 'invalid input syntax for type integer: "{"method":"POST","url":"https://rnjgeloamtszdjplmqxy.supabase.co/rest/v1/rpc/increment","headers":{"X-Client-Info":"supabase-js-node/2.50.2"},"schema":"public","body":{"value":1}}"'
}
```

Se debe a que el código intentaba usar `supabaseAdmin.rpc('increment', { value: 1 })` dentro de una actualización, lo cual no es válido.

## Solución

### 1. Aplicar la migración SQL

Primero, necesitas aplicar la migración SQL que crea la función `increment_visitor_sessions`:

```sql
-- Ejecutar en tu consola de Supabase SQL Editor
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
```

### 2. Aplicar mediante script (alternativo)

Si prefieres usar el script, ejecuta:

```bash
# Aplicar migración
node scripts/apply-increment-visitor-sessions-migration.js

# Probar la función
node scripts/test-increment-visitor-sessions.js
```

## Cambios realizados

### En el código API (`src/app/api/visitors/session/route.ts`)

**Antes:**
```typescript
const { error: visitorUpdateError } = await supabaseAdmin
  .from('visitors')
  .update({
    last_seen_at: startTime,
    total_sessions: supabaseAdmin.rpc('increment', { value: 1 }) // ❌ Esto no funciona
  })
  .eq('id', visitorId);
```

**Después:**
```typescript
const { error: visitorUpdateError } = await supabaseAdmin
  .rpc('increment_visitor_sessions', {
    visitor_id: visitorId,
    last_seen_timestamp: startTime
  });

// Con fallback si la función no existe
if (visitorUpdateError) {
  // Obtener el valor actual y incrementarlo
  const { data: currentVisitor, error: fetchError } = await supabaseAdmin
    .from('visitors')
    .select('total_sessions')
    .eq('id', visitorId)
    .single();
  
  if (!fetchError && currentVisitor) {
    const { error: fallbackUpdateError } = await supabaseAdmin
      .from('visitors')
      .update({
        last_seen_at: startTime,
        total_sessions: (currentVisitor.total_sessions || 0) + 1
      })
      .eq('id', visitorId);
  }
}
```

## Verificación

Una vez aplicada la migración, puedes verificar que la función existe:

```sql
SELECT routine_name, routine_type 
FROM information_schema.routines 
WHERE routine_name = 'increment_visitor_sessions';
```

## Beneficios

1. **Atomicidad**: La función SQL es atómica, evitando condiciones de carrera
2. **Rendimiento**: Más eficiente que hacer múltiples queries
3. **Fallback**: Si la función no existe, usa el método tradicional
4. **Mantenibilidad**: Código más limpio y fácil de mantener

## Troubleshooting

Si sigues teniendo problemas:

1. **Verifica las variables de entorno**: `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`
2. **Verifica permisos**: Asegúrate de que el service role key tenga permisos para ejecutar funciones
3. **Verifica la función**: Usa el SQL Editor de Supabase para verificar que la función existe

## Próximos pasos

Una vez que la migración esté aplicada:

1. Reinicia tu aplicación
2. Prueba crear una nueva sesión
3. Verifica que no aparezca el error `22P02`
4. Monitorea los logs para confirmar que funciona correctamente 