# RLS Policies Configuration

Este directorio contiene los scripts de migración y utilidades para configurar las políticas de Row Level Security (RLS) en Supabase.

## Migración Aplicada: `20250128_configure_rls_policies.sql`

### 🔒 Políticas de Acceso Configuradas

**IMPORTANTE**: Esta migración actualiza las políticas RLS de 3 tablas existentes.

#### 1. **allowed_domains** - Acceso Basado en Sitios
- **SELECT**: Usuarios pueden ver dominios de sus sitios (owners/members)
- **INSERT**: Solo owners y admins pueden agregar dominios a sus sitios
- **UPDATE**: Solo owners y admins pueden modificar dominios de sus sitios
- **DELETE**: Solo owners y admins pueden eliminar dominios de sus sitios

#### 2. **companies** - Lectura/Escritura para Usuarios Logueados (Sin Borrado)
- **SELECT**: Cualquier usuario autenticado puede ver empresas
- **INSERT**: Cualquier usuario autenticado puede crear empresas
- **UPDATE**: Cualquier usuario autenticado puede modificar empresas
- **DELETE**: ❌ **NADIE puede eliminar empresas** (sin política de DELETE)

#### 3. **cron_status** - Solo Superadmin
- **SELECT**: Solo superadmin puede ver el estado de cron jobs
- **INSERT**: Solo superadmin puede crear nuevos cron jobs
- **UPDATE**: Solo superadmin puede modificar cron jobs
- **DELETE**: Solo superadmin puede eliminar cron jobs

### 🔧 Cambios Realizados

1. **Actualiza políticas de `allowed_domains`** para seguir el patrón de acceso basado en sitios (similar a `api_keys`)
2. **Habilita RLS y crea políticas** para `companies` (acceso de lectura/escritura a usuarios autenticados, **sin borrado**)
3. **Habilita RLS y crea políticas** para `cron_status` (acceso solo a superadmin)
4. **Crea función helper** `is_superadmin()` para verificar roles

### 📋 Niveles de Acceso para `allowed_domains`

Los usuarios pueden acceder a dominios permitidos de un sitio si:
- **Son el propietario directo** del sitio (`sites.user_id`)
- **Son miembros activos** del sitio (`site_members` con `status = 'active'`)
- **Tienen ownership** del sitio (`site_ownership` table)

Para **modificar** dominios (INSERT/UPDATE/DELETE) necesitan ser:
- **Propietario directo** del sitio, O
- **Miembro con rol `owner` o `admin`** del sitio, O
- **Tienen ownership** del sitio

### ⚠️ Protección de Datos para `companies`

La tabla `companies` está protegida contra eliminación:
- **Sin política DELETE** = Nadie puede borrar empresas
- **Datos preservados** = Información empresarial se mantiene intacta
- **Solo lectura/escritura** = Usuarios pueden ver, crear y editar, pero nunca eliminar

## 🛠️ Utilidades de Administración: `admin_utils.sql`

### Funciones Disponibles

#### 1. Otorgar Rol de Superadmin
```sql
SELECT public.grant_superadmin_role('admin@example.com');
```

#### 2. Revocar Rol de Superadmin
```sql
SELECT public.revoke_superadmin_role('admin@example.com');
```

#### 3. Verificar Estado de Superadmin
```sql
SELECT * FROM public.check_user_superadmin_status('admin@example.com');
```

### 📝 Queries de Prueba

#### Listar todos los superadmins actuales:
```sql
SELECT 
    email,
    raw_user_meta_data->>'role' as role,
    created_at
FROM auth.users 
WHERE raw_user_meta_data->>'role' = 'superadmin';
```

#### Probar acceso a las tablas:
```sql
-- Funciona para usuarios con acceso a sitios (owners/members)
SELECT * FROM public.allowed_domains LIMIT 5;

-- Solo funciona para superadmin
SELECT * FROM public.cron_status LIMIT 5;

-- Funciona para cualquier usuario autenticado (lectura/escritura, NO borrado)
SELECT * FROM public.companies LIMIT 5;
INSERT INTO public.companies (name, industry) VALUES ('Test Company', 'technology');
UPDATE public.companies SET description = 'Updated description' WHERE name = 'Test Company';
-- DELETE FROM public.companies WHERE name = 'Test Company'; -- ❌ ESTO FALLARÁ
```

#### Verificar políticas aplicadas:
```sql
-- Ver todas las políticas de las 3 tablas
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check 
FROM pg_policies 
WHERE tablename IN ('allowed_domains', 'companies', 'cron_status')
ORDER BY tablename, policyname;
```

#### Verificar acceso a sitios:
```sql
-- Ver sitios a los que tengo acceso
SELECT 
    s.id,
    s.name,
    'owner' as access_type
FROM public.sites s 
WHERE s.user_id = auth.uid()

UNION ALL

SELECT 
    sm.site_id,
    s.name,
    sm.role as access_type
FROM public.site_members sm
JOIN public.sites s ON s.id = sm.site_id
WHERE sm.user_id = auth.uid() AND sm.status = 'active'

UNION ALL

SELECT 
    so.site_id,
    s.name,
    'ownership' as access_type
FROM public.site_ownership so
JOIN public.sites s ON s.id = so.site_id
WHERE so.user_id = auth.uid();
```

## 🚀 Cómo Aplicar la Migración

### Opción 1: Supabase CLI
```bash
# Aplicar la migración
supabase db push

# O aplicar específicamente este archivo
psql -h your-host -U postgres -d your-database -f supabase/migrations/20250128_configure_rls_policies.sql
```

### Opción 2: Dashboard de Supabase
1. Ve a tu proyecto en Supabase Dashboard
2. Navega a "SQL Editor"
3. Copia y pega el contenido de `20250128_configure_rls_policies.sql`
4. Ejecuta el script

### Opción 3: Aplicar utilidades de admin
1. Ejecuta primero la migración principal
2. Luego ejecuta `admin_utils.sql` para las funciones de utilidades

## ⚠️ Consideraciones Importantes

1. **Acceso a `allowed_domains`**: Ahora sigue el patrón estándar del proyecto basado en pertenencia a sitios, no requiere superadmin.

2. **Protección de `companies`**: Las empresas no pueden ser eliminadas por nadie. Solo se permite crear, leer y actualizar.

3. **Tablas Existentes**: Esta migración asume que las 3 tablas (`allowed_domains`, `companies`, `cron_status`) ya existen en tu base de datos.

4. **Backup**: Asegúrate de hacer un backup de tu base de datos antes de aplicar estos cambios.

## 🔧 Solución de Problemas

### Error: "No rows returned" para allowed_domains
Si no puedes acceder a `allowed_domains`, verifica que tengas acceso al sitio:

```sql
-- Verificar acceso a sitios
SELECT * FROM public.sites WHERE user_id = auth.uid();
SELECT * FROM public.site_members WHERE user_id = auth.uid() AND status = 'active';
```

### Error: "No rows returned" para cron_status
Si no puedes acceder a `cron_status`, verifica que tu usuario tenga el rol de superadmin:

```sql
SELECT public.check_user_superadmin_status('tu-email@example.com');
```

### Error: "Permission denied" al intentar DELETE en companies
Esto es esperado. La tabla `companies` no permite operaciones DELETE por diseño.

### Error: "Function does not exist"
Si las funciones de utilidades no están disponibles, ejecuta el archivo `admin_utils.sql`.

### Error: "Table does not exist"
Si alguna de las 3 tablas no existe, esta migración fallará. Asegúrate de que `allowed_domains`, `companies` y `cron_status` existan antes de ejecutar.

### Error: "Policy already exists"
Si encuentras errores de políticas que ya existen, puedes eliminarlas manualmente antes de aplicar la migración:

```sql
-- Ejemplo para allowed_domains
DROP POLICY IF EXISTS "policy_name" ON public.allowed_domains;
```

## 📚 Referencias

- [Supabase RLS Documentation](https://supabase.com/docs/guides/auth/row-level-security)
- [PostgreSQL RLS Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) 