# CaseConverterService

Servicio utilitario para conversión entre camelCase y snake_case que permite trabajar con variables en cualquier formato de manera flexible.

## Características

- ✅ Convierte automáticamente entre camelCase y snake_case
- ✅ Busca propiedades en objetos independientemente del formato
- ✅ Normaliza objetos completos (incluyendo objetos anidados y arrays)
- ✅ Valida campos requeridos en cualquier formato
- ✅ Mapea propiedades con múltiples nombres posibles
- ✅ Middleware para APIs que acepta ambos formatos

## Instalación

```typescript
import { 
  CaseConverterService, 
  getFlexibleProperty,
  camelToSnake,
  snakeToCamel 
} from '@/lib/utils/case-converter';
```

## Uso Básico

### Conversión de Strings

```typescript
// camelCase → snake_case
camelToSnake('userId') // 'user_id'
camelToSnake('teamMemberId') // 'team_member_id'

// snake_case → camelCase
snakeToCamel('user_id') // 'userId'
snakeToCamel('team_member_id') // 'teamMemberId'
```

### Conversión de Objetos

```typescript
// Convertir objeto completo a snake_case
const camelData = {
  userId: '123',
  teamMemberId: '456',
  userInfo: {
    firstName: 'John',
    lastName: 'Doe'
  }
};

const snakeData = CaseConverterService.normalizeRequestData(camelData, 'snake');
// Resultado:
// {
//   user_id: '123',
//   team_member_id: '456',
//   user_info: {
//     first_name: 'John',
//     last_name: 'Doe'
//   }
// }
```

### Búsqueda Flexible de Propiedades

```typescript
const mixedData = {
  userId: '123',
  team_member_id: '456',
  email: 'test@example.com'
};

// Busca la propiedad en cualquier formato
getFlexibleProperty(mixedData, 'user_id') // '123' (encuentra userId)
getFlexibleProperty(mixedData, 'teamMemberId') // '456' (encuentra team_member_id)
getFlexibleProperty(mixedData, 'email') // 'test@example.com' (encuentra email)
```

## Uso en APIs

### Ejemplo 1: API que acepta ambos formatos

```typescript
export async function POST(request: NextRequest) {
  try {
    const requestData = await request.json();
    
    // Normalizar automáticamente a snake_case
    const normalizedData = CaseConverterService.normalizeRequestData(requestData, 'snake');
    
    // Validar con schema (siempre en snake_case)
    const validationResult = MySchema.safeParse(normalizedData);
    
    // Extraer parámetros de manera flexible
    const siteId = getFlexibleProperty(requestData, 'site_id');
    const userId = getFlexibleProperty(requestData, 'user_id');
    
    // ... resto de la lógica
    
  } catch (error) {
    // ... manejo de errores
  }
}
```

### Ejemplo 2: Validación de campos requeridos

```typescript
// Valida que estén presentes, independientemente del formato
const hasRequired = CaseConverterService.hasRequiredProperties(requestData, [
  'site_id',    // Encuentra siteId o site_id
  'user_id',    // Encuentra userId o user_id
  'email'       // Encuentra email
]);

if (!hasRequired) {
  return { error: 'Faltan campos requeridos' };
}
```

### Ejemplo 3: Mapeo de propiedades con múltiples nombres

```typescript
const mapping = {
  site_id: ['siteId', 'site_id'],
  user_id: ['userId', 'user_id'],
  team_member_id: ['teamMemberId', 'team_member_id', 'memberId'],
  analysis_type: ['analysisType', 'analysis_type', 'type']
};

const mappedData = CaseConverterService.mapFlexibleProperties(mapping, requestData);
```

## Métodos Disponibles

### CaseConverterService

| Método | Descripción |
|--------|-------------|
| `normalizeRequestData(data, format)` | Normaliza un objeto al formato especificado |
| `extractFlexibleProperties(obj, keys)` | Extrae propiedades específicas en cualquier formato |
| `hasRequiredProperties(obj, keys)` | Valida que todas las propiedades requeridas estén presentes |
| `mapFlexibleProperties(mapping, obj)` | Mapea propiedades usando múltiples nombres posibles |

### Funciones Utilitarias

| Función | Descripción |
|---------|-------------|
| `camelToSnake(str)` | Convierte string de camelCase a snake_case |
| `snakeToCamel(str)` | Convierte string de snake_case a camelCase |
| `objectKeysToSnake(obj)` | Convierte todas las claves de un objeto a snake_case |
| `objectKeysToCamel(obj)` | Convierte todas las claves de un objeto a camelCase |
| `getFlexibleProperty(obj, key)` | Busca una propiedad en cualquier formato |
| `setFlexibleProperty(obj, key, value, preferSnake)` | Establece una propiedad en el formato preferido |

## Casos de Uso

### 1. APIs que deben ser compatibles con diferentes clientes
```typescript
// Cliente JavaScript (camelCase)
fetch('/api/users', {
  body: JSON.stringify({ userId: '123', teamMemberId: '456' })
});

// Cliente Python (snake_case)
requests.post('/api/users', json={'user_id': '123', 'team_member_id': '456'})

// Ambos funcionan con la misma API
```

### 2. Migración gradual de APIs
```typescript
// Permite mantener compatibilidad mientras migras
const siteId = getFlexibleProperty(requestData, 'site_id') || 
               getFlexibleProperty(requestData, 'siteId') ||
               getFlexibleProperty(requestData, 'id');
```

### 3. Integración con bases de datos
```typescript
// Normalizar antes de guardar en DB (que usa snake_case)
const dbData = CaseConverterService.normalizeRequestData(apiData, 'snake');
await db.insert('users', dbData);

// Normalizar antes de enviar al frontend (que usa camelCase)
const frontendData = CaseConverterService.normalizeRequestData(dbData, 'camel');
return NextResponse.json(frontendData);
```

## Tests

El servicio incluye tests completos que puedes ejecutar con:

```bash
npm test -- --testPathPattern=case-converter.test.ts
```

## Beneficios

1. **Flexibilidad**: Las APIs pueden aceptar datos en cualquier formato
2. **Consistencia**: Normalización automática para consistencia interna
3. **Compatibilidad**: Soporte para diferentes convenciones de naming
4. **Mantenibilidad**: Código más limpio y fácil de mantener
5. **Migración**: Facilita la migración entre diferentes formatos

## Ejemplo Completo

Ver `case-converter-example.ts` para ejemplos completos de implementación. 