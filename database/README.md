# Esquema de Base de Datos Supabase

Este directorio contiene herramientas para analizar y visualizar el esquema de la base de datos Supabase utilizada en el proyecto.

## Cómo obtener el esquema actual

1. Inicie sesión en su panel de control de Supabase
2. Vaya a la sección "SQL Editor"
3. Copie y pegue la consulta del archivo `schema.sql` original
4. Ejecute la consulta
5. Copie los resultados JSON y guárdelos en el archivo `schema.sql` (reemplazando la consulta)

## Análisis del esquema

Una vez que tenga el resultado JSON del esquema en el archivo `schema.sql`, puede utilizar el script de análisis incluido:

```bash
cd database
./analyze.sh
```

Este script interactivo le permitirá elegir entre:
- Analizador JavaScript (Node.js)
- Analizador Python (Python 3)
- Ambos analizadores

### Archivos generados

Los analizadores generarán los siguientes archivos:

- **schema_summary.md**: Resumen detallado del esquema en formato Markdown
  - Lista de todos los esquemas y tablas
  - Detalles de columnas, tipos de datos y restricciones
  - Información sobre claves primarias y foráneas

- **schema_relations.md**: Diagrama de relaciones entre tablas en formato Mermaid
  - Representación visual de las tablas y sus relaciones
  - Útil para entender la estructura de la base de datos

- **schema_stats.json**: Estadísticas del esquema en formato JSON
  - Número total de esquemas, tablas y columnas
  - Detalles por esquema y tabla
  - Información sobre restricciones

### Características de los analizadores

#### Analizador JavaScript

```bash
node schema_analyzer.js
```

- Genera un resumen detallado del esquema
- Crea un diagrama de relaciones
- Proporciona estadísticas sobre el esquema
- Muestra información detallada durante el proceso

#### Analizador Python

```bash
python schema_analyzer.py
```

- Genera un resumen detallado del esquema
- Crea un diagrama de relaciones más completo
- Proporciona estadísticas detalladas
- Genera un archivo JSON con estadísticas
- Incluye marcas de tiempo en los archivos generados

## Estructura de la consulta original

La consulta SQL proporcionada devuelve la siguiente información para cada columna en la base de datos:

- **schema**: El esquema al que pertenece la tabla
- **table**: Nombre de la tabla
- **column**: Nombre de la columna
- **data_type**: Tipo de datos de la columna
- **nullable**: Si la columna permite valores NULL o no
- **constraint_type**: Tipo de restricción (PRIMARY KEY, UNIQUE, FOREIGN KEY)
- **references_table**: Para claves foráneas, la tabla a la que hace referencia

## Alternativas

También puede obtener información del esquema utilizando:

1. La interfaz de Supabase en la sección "Table Editor"
2. Exportando la base de datos completa desde la sección "Database" > "Backups"
3. Utilizando la API de Supabase para obtener metadatos de la base de datos

## Uso del esquema

Una vez que tenga el esquema analizado, puede utilizarlo para:

- Documentación del proyecto
- Planificación de migraciones
- Desarrollo de nuevas características
- Comprensión de la estructura de datos actual
- Visualización de relaciones entre tablas
- Identificación de posibles mejoras en la estructura de la base de datos 