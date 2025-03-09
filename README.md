# AI Site Analyzer

Una herramienta avanzada para analizar sitios web utilizando inteligencia artificial. Esta aplicación permite realizar análisis detallados de la estructura, contenido y experiencia de usuario de cualquier sitio web.

## Características

- **Análisis Básico**: Evaluación rápida del sitio con resumen, insights y recomendaciones.
- **Análisis Detallado**: Evaluación profunda con recomendaciones específicas y detalladas.
- **Análisis Estructurado**: Análisis completo de la estructura del DOM, identificando bloques, jerarquía y elementos interactivos.
- **Captura de Pantalla**: Opción para incluir capturas de pantalla en el análisis.
- **Múltiples Modelos de IA**: Soporte para diferentes proveedores de IA (Anthropic, OpenAI, Google).

## Tecnologías

- **Frontend**: Next.js, React, Tailwind CSS
- **Backend**: Next.js API Routes
- **IA**: Integración con Claude (Anthropic), GPT (OpenAI) y Gemini (Google)
- **Web Scraping**: Puppeteer, Axios, Cheerio

## Estructura del Proyecto

```
site-analyzer/
├── public/                  # Archivos estáticos
├── src/
│   ├── app/                 # Componentes y páginas de la aplicación
│   │   ├── api/             # Rutas de API
│   │   │   └── site/
│   │   │       └── analyze/ # Endpoints de análisis
│   │   ├── components/      # Componentes React
│   │   └── page.tsx         # Página principal
│   └── lib/                 # Lógica de la aplicación
│       ├── agents/          # Agentes de IA
│       ├── config/          # Configuración
│       ├── prompts/         # Prompts para modelos de IA
│       ├── services/        # Servicios de análisis
│       ├── types/           # Definiciones de tipos
│       └── utils/           # Utilidades
```

## Instalación

1. Clona el repositorio:
   ```bash
   git clone https://github.com/tu-usuario/ai-site-analyzer.git
   cd ai-site-analyzer
   ```

2. Instala las dependencias:
   ```bash
   npm install
   ```

3. Crea un archivo `.env.local` con tus claves de API:
   ```
   ANTHROPIC_API_KEY=tu_clave_de_anthropic
   OPENAI_API_KEY=tu_clave_de_openai
   GOOGLE_API_KEY=tu_clave_de_google
   ```

4. Inicia el servidor de desarrollo:
   ```bash
   npm run dev
   ```

5. Abre [http://localhost:3000](http://localhost:3000) en tu navegador.

## Uso

1. Ingresa la URL del sitio web que deseas analizar.
2. Selecciona el tipo de análisis (Básico, Detallado o Estructurado).
3. Configura opciones adicionales (captura de pantalla, proveedor de IA, modelo).
4. Haz clic en "Analizar" y espera los resultados.

## Contribución

Las contribuciones son bienvenidas. Por favor, sigue estos pasos:

1. Haz fork del repositorio
2. Crea una rama para tu característica (`git checkout -b feature/amazing-feature`)
3. Haz commit de tus cambios (`git commit -m 'Add some amazing feature'`)
4. Haz push a la rama (`git push origin feature/amazing-feature`)
5. Abre un Pull Request

## Licencia

Este proyecto está licenciado bajo la Licencia MIT - ver el archivo [LICENSE](LICENSE) para más detalles. 