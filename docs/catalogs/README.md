# Catálogo floral de ejemplo

`catalogo-floral-1200.csv` contiene **1200 productos y variantes comerciales**,
en español, distribuidos en **14 categorías**. No representa 1200 especies
botánicas distintas ni un inventario real.

## Formato

Mantiene exactamente las nueve columnas de la plantilla proporcionada:

```text
sku,name,description,target_sale_price,cost,lowest_sale_price,currency,category,image_url
```

- SKU y nombre únicos para cada fila.
- Variantes de especie/color, cantidad de tallos, presentación, tamaño o empaque
  identificadas en el nombre y la descripción.
- Cada variante es una fila independiente. La plantilla no contiene `parent_id`
  ni campos para vincular productos padre e hijo.
- Categorías expresadas como nombres, no identificadores de base de datos.
- Precios y costos ficticios en USD, conservando la moneda de la plantilla.
  No son cotizaciones de proveedores ni precios de mercado verificados.
- Dos decimales y relación `cost <= lowest_sale_price <= target_sale_price`.
- `image_url` vacío: no se inventan fotografías ni enlaces.
- CSV UTF-8, separado por comas, con campos entre comillas y finales CRLF.

## Distribución

| Categoría | Filas |
| --- | ---: |
| Flores de corte | 240 |
| Ramos y bouquets | 240 |
| Arreglos en jarrón | 80 |
| Cajas de flores | 80 |
| Canastas florales | 80 |
| Flores para bodas | 120 |
| Flores para condolencias | 120 |
| Plantas con flor | 60 |
| Flores secas y preservadas | 60 |
| Jarrones y recipientes | 30 |
| Bases y espuma floral | 18 |
| Empaques florales | 36 |
| Complementos de regalo | 24 |
| Herramientas y cuidado floral | 12 |
| **Total** | **1200** |

## Regeneración y validación

Con las dependencias del proyecto instaladas y Node.js disponible:

```sh
node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/generate-floral-catalog.mjs
```

El script valida el total de filas, columnas, unicidad de SKU y nombre,
campos obligatorios, precios y lectura del CSV con `csv-parse`. Regenerarlo
sobrescribe el CSV de ejemplo de forma determinista.

No se realiza ninguna importación ni modificación de la base de datos.
Antes de utilizarlo comercialmente, revisar precios, disponibilidad, medidas,
imágenes y las reglas del importador de destino para categorías y variantes.