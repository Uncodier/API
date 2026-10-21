#!/usr/bin/env node
// Offline example data only. This script never imports products into a database.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';

const outputDirectory = new URL('../docs/catalogs/', import.meta.url);
const outputFile = new URL('catalogo-floral-1200.csv', outputDirectory);
const columns = [
  'sku', 'name', 'description', 'target_sale_price', 'cost',
  'lowest_sale_price', 'currency', 'category', 'image_url',
];
const products = [];
const groupCounts = new Map();

function addProduct(group, category, name, description, costCents) {
  assert(Number.isSafeInteger(costCents) && costCents > 0);
  const sequence = (groupCounts.get(group) ?? 0) + 1;
  groupCounts.set(group, sequence);
  products.push({
    sku: `FL-${group}-${String(sequence).padStart(4, '0')}`,
    name,
    description,
    target_sale_price: (Math.ceil(costCents * 2.25 / 50) * 50 / 100).toFixed(2),
    cost: (costCents / 100).toFixed(2),
    lowest_sale_price: (Math.ceil(costCents * 1.65 / 50) * 50 / 100).toFixed(2),
    currency: 'USD',
    category,
    image_url: '',
  });
}

// Realistic flower/color combinations; prices are synthetic USD cost estimates.
const flowers = [
  ['Rosa roja', 150], ['Rosa blanca', 150], ['Rosa rosa', 150],
  ['Rosa amarilla', 150], ['Rosa naranja', 165], ['Rosa lavanda', 175],
  ['Rosa durazno', 165], ['Rosa bicolor crema y rosa', 185],
  ['Rosa de jardín rosa', 300], ['Rosa de jardín crema', 300],
  ['Tulipán rojo', 220], ['Tulipán amarillo', 220], ['Tulipán blanco', 230],
  ['Tulipán rosa', 230], ['Tulipán morado', 240],
  ['Girasol amarillo', 250], ['Gerbera roja', 160], ['Gerbera naranja', 160],
  ['Gerbera rosa', 160], ['Gerbera amarilla', 160],
  ['Clavel rojo', 80], ['Clavel blanco', 80], ['Clavel rosa', 80],
  ['Clavel miniatura rosa', 100], ['Lirio oriental blanco', 350],
  ['Lirio oriental rosa', 350], ['Lirio asiático naranja', 280],
  ['Alstroemeria blanca', 110], ['Alstroemeria rosa', 110],
  ['Alstroemeria amarilla', 110], ['Lisianthus blanco', 240],
  ['Lisianthus morado', 240], ['Lisianthus rosa', 240],
  ['Hortensia azul', 450], ['Hortensia blanca', 450],
  ['Hortensia rosa', 450], ['Peonía rosa', 650], ['Peonía blanca', 650],
  ['Crisantemo blanco', 120], ['Crisantemo amarillo', 120],
];
const stemCounts = [1, 3, 6, 12, 24, 50];
for (const [flower, unitCost] of flowers) {
  for (const stems of stemCounts) {
    addProduct('FLO', 'Flores de corte', `${flower} — ${stems} ${stems === 1 ? 'tallo' : 'tallos'}`,
      `Flor de corte: ${flower.toLowerCase()}. Presentación de ${stems} ${stems === 1 ? 'tallo' : 'tallos'}, sin jarrón. Para floristería y composiciones personalizadas. Sujeta a disponibilidad estacional; el número de flores abiertas por tallo varía según la especie.`,
      unitCost * stems + 50);
  }
}

// The number in each variant counts flower stems, not additional greenery.
const recipes = [
  ['Amor clásico', 'rosas rojas', 155, 'aniversarios y regalos románticos'],
  ['Pureza', 'rosas blancas y lisianthus blanco', 195, 'agradecimientos y celebraciones'],
  ['Dulce ternura', 'rosas rosa y alstroemerias rosa', 140, 'cumpleaños y nacimientos'],
  ['Alegría dorada', 'girasoles y crisantemos amarillos', 190, 'cumpleaños y felicitaciones'],
  ['Atardecer', 'gerberas naranja y rosas durazno', 170, 'celebraciones y agradecimientos'],
  ['Jardín lavanda', 'rosas lavanda y lisianthus morado', 210, 'regalos y aniversarios'],
  ['Primavera', 'tulipanes rosa y tulipanes amarillos', 230, 'regalos de temporada'],
  ['Elegancia oriental', 'lirios orientales blancos y rosas blancas', 250, 'aniversarios y recepciones'],
  ['Pasión bicolor', 'rosas rojas y rosas blancas', 155, 'regalos románticos'],
  ['Fiesta de color', 'gerberas rojas, gerberas rosa y gerberas amarillas', 165, 'cumpleaños'],
  ['Brisa azul', 'hortensias azules y rosas blancas', 310, 'bienvenidas y celebraciones'],
  ['Jardín de peonías', 'peonías rosa y rosas de jardín crema', 480, 'regalos de temporada'],
  ['Romance de jardín', 'rosas de jardín rosa y lisianthus blanco', 280, 'aniversarios y compromisos'],
  ['Sol de verano', 'girasoles y alstroemerias amarillas', 185, 'felicitaciones'],
  ['Encanto durazno', 'rosas durazno y claveles blancos', 130, 'agradecimientos'],
  ['Delicadeza blanca', 'lisianthus blanco y alstroemerias blancas', 180, 'regalos y recepciones'],
  ['Tulipanes de pasión', 'tulipanes rojos y tulipanes blancos', 225, 'aniversarios'],
  ['Claveles de cariño', 'claveles rosa y claveles miniatura rosa', 95, 'detalles y agradecimientos'],
  ['Luz tropical', 'lirios asiáticos naranja y gerberas amarillas', 225, 'celebraciones'],
  ['Nube rosa', 'hortensias rosa y rosas rosa', 305, 'cumpleaños y nacimientos'],
];
const bouquetWraps = [
  ['kraft natural', 150], ['papel coreano blanco', 250], ['papel translúcido', 200],
];
for (const [design, composition, unitCost, occasion] of recipes) {
  for (const stems of [6, 12, 18, 24]) {
    for (const [wrap, wrapCost] of bouquetWraps) {
      addProduct('RAM', 'Ramos y bouquets', `Ramo ${design} — ${stems} tallos — ${wrap}`,
        `Ramo de ${stems} tallos florales en total de ${composition}, con follaje de acompañamiento. Envoltura de ${wrap} y cinta coordinada. Pensado para ${occasion}. No incluye jarrón; distribución de especies según diseño y disponibilidad estacional.`,
        stems * unitCost + wrapCost + 450);
    }
  }
}

const containers = [
  ['jarrón de vidrio', 'Arreglos en jarrón', 850],
  ['caja rígida', 'Cajas de flores', 650],
  ['canasta de mimbre', 'Canastas florales', 950],
];
for (const [design, composition, unitCost, occasion] of recipes) {
  for (const stems of [12, 24, 36, 48]) {
    for (const [container, category, containerCost] of containers) {
      addProduct('ARR', category, `Arreglo ${design} — ${stems} tallos — ${container}`,
        `Composición de ${stems} tallos florales en total de ${composition}, con follaje. Incluye ${container}. Montaje hidratado y listo para exhibir; ideal para ${occasion}. Distribución de especies según diseño y disponibilidad estacional.`,
        stems * unitCost + containerCost + 900);
    }
  }
}

const palettes = [
  ['blanco y verde', 'rosas blancas, lisianthus blanco y follaje verde', 195],
  ['rosa y crema', 'rosas rosa, rosas crema y follaje verde', 185],
  ['rojo y blanco', 'rosas rojas, claveles blancos y follaje verde', 145],
];
const weddingDesigns = [
  ['Ramo de novia redondo', 'bouquet de mano con empuñadura encintada', 1200],
  ['Ramo de novia en cascada', 'bouquet de caída alargada con empuñadura encintada', 1800],
  ['Ramo de dama de honor', 'bouquet de mano coordinado para el cortejo', 600],
  ['Centro de mesa nupcial bajo', 'composición en recipiente bajo incluido', 1200],
  ['Centro de mesa nupcial alto', 'composición con base alta incluida', 1800],
  ['Arreglo para altar', 'composición frontal en base incluida', 1800],
  ['Arreglo para bienvenida de boda', 'composición en jarrón incluido para la recepción', 1500],
  ['Guirnalda floral para mesa', 'composición lineal sobre soporte de hidratación incluido', 1200],
  ['Módulo floral para arco', 'módulo con soporte de fijación; estructura del arco no incluida', 1800],
  ['Arreglo para silla de ceremonia', 'composición con cinta de sujeción; silla no incluida', 650],
];
for (const [design, format, assemblyCost] of weddingDesigns) {
  for (const stems of [12, 18, 24, 36]) {
    for (const [palette, composition, unitCost] of palettes) {
      addProduct('BOD', 'Flores para bodas', `${design} — ${stems} tallos — ${palette}`,
        `${design}: ${format}. Incluye ${stems} tallos florales en total de ${composition}. Paleta ${palette}. Venta por pieza o módulo, no por evento completo; transporte e instalación en el lugar no incluidos. Flores sujetas a disponibilidad estacional.`,
        stems * unitCost + assemblyCost);
    }
  }
}

const sympathyDesigns = [
  ['Corona de condolencias', 'corona circular con base incluida', 1700],
  ['Cruz floral de condolencias', 'composición en forma de cruz con soporte incluido', 1700],
  ['Corazón floral de recuerdo', 'composición en forma de corazón con soporte incluido', 1800],
  ['Palma funeraria', 'composición alargada con base incluida', 1200],
  ['Centro de condolencias', 'composición baja con recipiente incluido', 900],
  ['Canasta de condolencias', 'composición en canasta incluida', 1000],
  ['Ramo de pésame', 'bouquet de mano con envoltura incluida', 500],
  ['Arreglo para urna', 'composición lateral en base incluida; urna no incluida', 1100],
  ['Manto floral de despedida', 'composición horizontal en base incluida', 1800],
  ['Arreglo de homenaje en pedestal', 'composición vertical con base; pedestal no incluido', 1500],
];
for (const [design, format, assemblyCost] of sympathyDesigns) {
  for (const stems of [18, 30, 42, 60]) {
    for (const [palette, composition, unitCost] of palettes) {
      addProduct('CON', 'Flores para condolencias', `${design} — ${stems} tallos — ${palette}`,
        `${design}: ${format}. Elaborado con ${stems} tallos florales en total de ${composition}. Paleta ${palette}; incluye cinta de condolencias con texto a confirmar. Venta por pieza; entrega y montaje en el lugar no incluidos. Sujeto a disponibilidad estacional.`,
        stems * unitCost + assemblyCost);
    }
  }
}

const plants = [
  ['Orquídea Phalaenopsis blanca', 1400], ['Orquídea Phalaenopsis rosa', 1400],
  ['Orquídea Phalaenopsis morada', 1450], ['Anturio rojo', 950],
  ['Anturio rosa', 1000], ['Spathiphyllum', 750], ['Kalanchoe naranja', 500],
  ['Kalanchoe rosa', 500], ['Begonia de flor roja', 550], ['Azalea rosa', 850],
];
for (const [plant, plantCost] of plants) {
  for (const [size, diameter, multiplier] of [['compacta', 12, 1], ['mediana', 15, 1.4], ['grande', 18, 1.9]]) {
    for (const [pot, potCost] of [['cubremaceta de cerámica', 700], ['cubremaceta de fibras naturales', 450]]) {
      addProduct('PLA', 'Plantas con flor', `${plant} — ${size} — ${pot}`,
        `Una planta viva de ${plant.toLowerCase()}, presentación ${size}, en maceta de cultivo de aproximadamente ${diameter} cm de diámetro y ${pot} incluido. Incluye indicaciones de cuidado. Altura, cantidad de varas y estado de floración variables; consultar disponibilidad.`,
        Math.round(plantCost * multiplier) + potCost);
    }
  }
}

const driedDesigns = [
  ['Ramo de lavanda seca', 'lavanda seca', 350],
  ['Ramo de statice seco', 'statice seco en tonos violeta', 300],
  ['Ramo de lagurus natural', 'lagurus seco natural', 300],
  ['Ramo de espigas de trigo', 'espigas de trigo secas', 250],
  ['Ramo de craspedia seca', 'craspedia amarilla seca', 450],
  ['Ramo de siemprevivas', 'siemprevivas secas de colores naturales', 400],
  ['Ramo de eucalipto preservado', 'eucalipto preservado verde', 650],
  ['Bouquet bohemio seco', 'lagurus, trigo y statice secos', 500],
  ['Bouquet natural seco', 'lavanda, trigo y siemprevivas secas', 500],
  ['Bouquet mixto preservado', 'hortensia preservada y eucalipto preservado', 950],
];
for (const [design, composition, materialCost] of driedDesigns) {
  for (const [size, stems, multiplier] of [['pequeño', 10, 1], ['mediano', 20, 1.8], ['grande', 30, 2.5]]) {
    for (const [presentation, presentationCost] of [['envuelto en kraft', 150], ['en jarrón de cerámica', 900]]) {
      addProduct('SEC', 'Flores secas y preservadas', `${design} — ${size} — ${presentation}`,
        `Diseño decorativo de ${composition}; tamaño ${size}, ${stems} tallos decorativos en total, ${presentation}. No requiere agua. Mantener en ambiente seco, sin sol directo y lejos de fuentes de calor. No es una planta viva; tonos y formas pueden variar.`,
        Math.round(materialCost * multiplier) + presentationCost + 400);
    }
  }
}

// Explicit measurements avoid applying fictitious colors or flower counts to accessories.
const accessories = [
  ['Jarrón cilíndrico de vidrio', 'Jarrones y recipientes', 'altura', 'cm', [10, 15, 20, 25, 30, 40], 500],
  ['Jarrón de cerámica blanca', 'Jarrones y recipientes', 'altura', 'cm', [10, 15, 20, 25, 30, 40], 650],
  ['Jarrón de cerámica terracota', 'Jarrones y recipientes', 'altura', 'cm', [10, 15, 20, 25, 30, 40], 650],
  ['Caja redonda para flores', 'Jarrones y recipientes', 'diámetro', 'cm', [10, 15, 20, 25, 30, 35], 350],
  ['Canasta de mimbre para flores', 'Jarrones y recipientes', 'ancho', 'cm', [15, 20, 25, 30, 35, 40], 500],
  ['Espuma floral para flor fresca', 'Bases y espuma floral', 'paquete', 'bloques', [1, 2, 4, 6, 12, 24], 150],
  ['Base plástica para centro floral', 'Bases y espuma floral', 'diámetro', 'cm', [10, 15, 20, 25, 30, 35], 160],
  ['Aro con espuma para corona floral', 'Bases y espuma floral', 'diámetro exterior', 'cm', [20, 25, 30, 35, 40, 50], 400],
  ['Papel kraft para ramos', 'Empaques florales', 'paquete', 'hojas', [5, 10, 20, 25, 50, 100], 15],
  ['Papel coreano blanco para ramos', 'Empaques florales', 'paquete', 'hojas', [5, 10, 20, 25, 50, 100], 25],
  ['Papel translúcido para ramos', 'Empaques florales', 'paquete', 'hojas', [5, 10, 20, 25, 50, 100], 20],
  ['Cinta de satén rosa de 25 mm', 'Empaques florales', 'rollo', 'm', [1, 3, 5, 10, 20, 50], 40],
  ['Cinta de satén blanca de 25 mm', 'Empaques florales', 'rollo', 'm', [1, 3, 5, 10, 20, 50], 40],
  ['Cordón de yute para ramos', 'Empaques florales', 'rollo', 'm', [1, 3, 5, 10, 20, 50], 20],
  ['Tarjeta de dedicatoria floral', 'Complementos de regalo', 'paquete', 'unidades', [1, 5, 10, 20, 50, 100], 35],
  ['Tarjeta de condolencias', 'Complementos de regalo', 'paquete', 'unidades', [1, 5, 10, 20, 50, 100], 35],
  ['Corazón decorativo en varilla', 'Complementos de regalo', 'paquete', 'unidades', [1, 3, 6, 12, 24, 48], 80],
  ['Mariposa decorativa en varilla', 'Complementos de regalo', 'paquete', 'unidades', [1, 3, 6, 12, 24, 48], 70],
  ['Conservante para flor cortada', 'Herramientas y cuidado floral', 'paquete', 'sobres', [1, 5, 10, 20, 50, 100], 20],
  ['Alambre floral revestido de 30 cm', 'Herramientas y cuidado floral', 'paquete', 'unidades', [10, 20, 30, 50, 100, 200], 8],
];
for (const [accessory, category, measurement, unit, values, baseCost] of accessories) {
  for (const value of values) {
    const isDimension = unit === 'cm';
    const cost = isDimension ? Math.round(baseCost * value / values[0]) : baseCost * value;
    const details = accessory.startsWith('Papel') ? ' Cada hoja mide aproximadamente 58 × 58 cm.'
      : accessory.startsWith('Espuma') ? ' Cada bloque mide aproximadamente 23 × 11 × 8 cm.'
      : accessory.startsWith('Conservante') ? ' Sobres monodosis de 5 g; usar según las instrucciones del fabricante.'
      : accessory.startsWith('Tarjeta') ? ' Tarjetas de aproximadamente 9 × 5 cm, sin texto personalizado.'
      : '';
    addProduct('ACC', category, `${accessory} — ${measurement} ${value} ${unit}`,
      `${accessory}. Presentación: ${measurement} de ${value} ${unit}.${details} Producto vendido por separado; no incluye flores, arreglos ni servicio de montaje.`,
      cost + 30);
  }
}

const expectedGroupCounts = { FLO: 240, RAM: 240, ARR: 240, BOD: 120, CON: 120, PLA: 60, SEC: 60, ACC: 120 };
assert.equal(products.length, 1200);
assert.deepEqual(Object.fromEntries(groupCounts), expectedGroupCounts);
assert.equal(new Set(products.map(product => product.sku)).size, products.length);
assert.equal(new Set(products.map(product => product.name)).size, products.length);
for (const product of products) {
  assert.deepEqual(Object.keys(product), columns);
  for (const column of columns.filter(column => column !== 'image_url')) {
    assert(product[column].trim().length > 0, `${product.sku}: empty ${column}`);
    assert(!/^[=+@\-\t\r\n]/u.test(product[column]), `${product.sku}: unsafe cell ${column}`);
  }
  for (const column of ['cost', 'lowest_sale_price', 'target_sale_price']) {
    assert(/^\d+\.\d{2}$/u.test(product[column]));
  }
  assert(Number(product.cost) <= Number(product.lowest_sale_price));
  assert(Number(product.lowest_sale_price) <= Number(product.target_sale_price));
  assert.equal(product.currency, 'USD');
  assert.equal(product.image_url, '');
}

const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const csv = [columns, ...products.map(product => columns.map(column => product[column]))]
  .map(row => row.map(quote).join(','))
  .join('\r\n') + '\r\n';
assert.deepEqual(parse(csv, { columns: true, skip_empty_lines: true }), products);
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(outputFile, csv, 'utf8');
assert.deepEqual(parse(readFileSync(outputFile), { columns: true }), products);

console.log(`Created and validated ${products.length} products: ${fileURLToPath(outputFile)}`);
console.log('Group totals:', Object.fromEntries(groupCounts));
console.log('Categories:', new Set(products.map(product => product.category)).size);