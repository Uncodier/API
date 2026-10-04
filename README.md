# Makinari API Server

A comprehensive Next.js-based API server for Makinari's AI team communication platform. This server provides REST endpoints and WebSocket support for managing AI agents, workflows, lead generation, email automation, and team coordination.

> **Note:** The underlying infrastructure is sometimes referred to as Uncodie, but the public product and API are branded as Makinari.

## Documentation

The official public documentation is hosted via Nextra in the `src/content` folder. You can view it live at [docs.makinari.com](https://docs.makinari.com).

To contribute to the documentation, please read [CONTRIBUTING.md](CONTRIBUTING.md).

### Durable IcyPeas email search

The new `POST /api/integrations/icypeas/email-search/resolve` performs one durable
submit-or-poll step per request, scoped to an authenticated site. Apply
`20261002000000_icypeas_email_searches.sql` **before API deployment**, then roll out
the separately patched polling worker. Ambiguous submits require manual recovery;
they are never automatically resubmitted. This is a bounded single-repair path,
not a new automated bulk/backfill runner: ICP work needs an explicit target budget,
serial execution and durable checkpoints. See the [deployment order, API/worker
contract, offline tests and recovery runbook](docs/README-IcyPeas-Durable-Email-Search.md).

## Features

- **AI Agent Management**: Coordinate and communicate with AI team members (Sales, Copywriter, Analyst)
- **Workflow Orchestration**: Multi-agent workflows powered by Temporal
- **Email Automation**: IMAP/SMTP integration for email processing and delivery status tracking
- **Real-time Communication**: WebSocket support for live team communication
- **Lead Management**: Lead generation, validation, and assignment workflows
- **Content Generation**: AI-powered content creation and calendar management
- **Integration Support**: Stripe, WhatsApp, SendGrid, Google Maps, and more

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** 22.12.0 or higher (see `package.json` engines)
- **npm** 9.0.0 or higher (or yarn)
- **Temporal Server** (for workflow orchestration) - optional for basic functionality
- **Supabase Account** (for database) - optional for local development

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd API
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   
   Copy the example environment file and configure it:
   ```bash
   cp src/config/env.example .env.local
   ```
   
   Edit `.env.local` with your configuration. At minimum, you'll need:
   - `NEXT_PUBLIC_SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key
   - `SERVICE_API_KEY` - Internal API key for service-to-service communication
   - `CRON_SECRET` - Bearer secret used by Vercel Cron
   - `ENCRYPTION_KEY` - 32-byte encryption key for API keys
   - `OPENROUTER_API_KEY` for chat, embeddings and video through OpenRouter; transcription uses direct Azure credentials and `AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT`
   - `AZURE_TTS_ENDPOINT` / `AZURE_TTS_API_KEY` for direct Azure text-to-speech, using the existing dedicated resource credentials

   See `src/config/env.example` for all available configuration options.

4. **Configure Temporal (Optional)**
   
   For local development, you can use Temporal's development server:
   ```bash
   # Install Temporal CLI
   temporal server start-dev
   ```
   
   This will start Temporal on `localhost:7233` (default configuration).

## Getting Started

### Development Mode

Start the API server in development mode:
```bash
npm run dev
```

This starts the Next.js server on `http://localhost:3001`.

For development with WebSocket support, start both the API server and WebSocket proxy:
```bash
npm run dev:all
```

This uses `concurrently` to run both:
- Next.js API server (port 3001)
- WebSocket server (from `wsServer.js`)

### Production Build

Check TypeScript before building (including generated Next.js route types and tests):
```bash
npm run typecheck
```

Build the application for production:
```bash
npm run build
```

Production builds also run TypeScript validation and fail on type errors; do not
enable `typescript.ignoreBuildErrors` to bypass a failing check.

Start the production server:
```bash
npm start
```

The server will start on port 3001 (configurable via environment variables).

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server on port 3001 |
| `npm run ws` | Start WebSocket server only |
| `npm run dev:all` | Start both API and WebSocket servers concurrently |
| `npm run build` | Build production bundle |
| `npm run typecheck` | Generate Next.js route types and check TypeScript without emitting code |
| `npm start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm test` | Run Jest test suite |
| `npm run test:chat-message` | Run specific test suite for chat messages |
| `npm run test:calendar-jest` | Run content calendar tests |

## Testing

Run the full test suite:
```bash
npm test
```

Run specific test suites:
```bash
# Chat message tests
npm run test:chat-message

# Content calendar tests
npm run test:calendar-jest
```

Tests are configured using Jest with TypeScript support. See `jest.config.js` for configuration details.

## Environment Variables

Key environment variables (see `src/config/env.example` for complete list):

### Required
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `SERVICE_API_KEY` - Internal service API key
- `CRON_SECRET` - Vercel Cron authentication secret
- `ENCRYPTION_KEY` - 32-byte encryption key

### AI Providers
- `OPENROUTER_API_KEY` - Gateway key for chat, tools, embeddings and video (not images, TTS or transcription)
- `OPENROUTER_CHAT_MODEL` - Defaults to `openai/gpt-6.1-sol`
- `AZURE_OPENAI_IMAGE_DEPLOYMENT` - Direct Azure image deployment, default `gpt-image-2.5-sunburst`
- `MICROSOFT_AZURE_OPENAI_ENDPOINT` / `MICROSOFT_AZURE_OPENAI_API_KEY` - Existing Azure resource credentials for images; optional dedicated `AZURE_OPENAI_IMAGE_ENDPOINT` / `AZURE_OPENAI_IMAGE_API_KEY`
- `AZURE_OPENAI_IMAGE_API_VERSION` - Default `preview` on `/openai/v1/images`; separate from the chat API version
- `OPENROUTER_VIDEO_MODEL` - Explicit video model selection required
- `AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT` - Required direct Azure transcription deployment; existing deployment is `gpt-transcribe`
- `AZURE_OPENAI_TRANSCRIPTION_API_VERSION` - Default `2024-10-21`; independent of the chat API version
- Transcription reuses `MICROSOFT_AZURE_OPENAI_ENDPOINT` / `MICROSOFT_AZURE_OPENAI_API_KEY` (or generic `AZURE_OPENAI_*` credentials); optional dedicated `AZURE_OPENAI_TRANSCRIPTION_ENDPOINT` / `AZURE_OPENAI_TRANSCRIPTION_API_KEY` take precedence
- `AZURE_TTS_ENDPOINT` / `AZURE_TTS_API_KEY` - Required existing dedicated credentials for direct Azure TTS; endpoint must be an HTTPS Azure resource origin or `/openai/v1/` base
- `AZURE_TTS_DEPLOYMENT` - Defaults to `tts-hd`; the resource/deployment must actually host a compatible Azure OpenAI TTS model
- `AZURE_TTS_API_VERSION` - Defaults to `2025-04-01-preview`; uses the dated `/openai/deployments/{deployment}/audio/speech` API even for an `/openai/v1/` base
- `AZURE_TTS_VOICE` - Defaults to `alloy`, an Azure OpenAI multilingual voice; do not use MAI voice IDs

See [OpenRouter migration and deployment checks](docs/OPENROUTER_MIGRATION.md).
Portkey credentials are no longer used by the migrated runtime paths. Images,
TTS and transcription use Azure directly, without OpenRouter fallback. The other
listed gateway capabilities remain on OpenRouter. TTS does not inherit chat
deployment/API-version settings or generic Azure credentials; stale
`OPENROUTER_TTS_MODEL` / `OPENROUTER_TTS_VOICE` settings are ignored. Supported TTS
formats are `mp3` (default), `pcm`, `wav`, `opus`, `aac` and `flac`; input is limited
to 4,096 characters and speed to `0.25`–`4`, inclusive. No new Azure resource or
deployment is created. After initial HTTP 404 failures, a real adapter smoke test
on the existing resource hosting `tts-hd`, with `2025-04-01-preview`, succeeded:
70,739 bytes of `audio/mpeg` with a valid MP3 signature in 2,881 ms. Server and CI
must explicitly configure the matched speech resource endpoint/key and this
speech API version. This was Azure inference, not a production deployment or
subjective pronunciation validation; no storage upload or database charge was
performed. See the migration guide for chronology and remaining acceptance checks.

### Temporal Configuration
- `TEMPORAL_ENV=development` - Environment mode
- `TEMPORAL_SERVER_URL=localhost:7233` - Temporal server URL
- `TEMPORAL_NAMESPACE=default` - Temporal namespace
- `WORKFLOW_TASK_QUEUE=default` - Task queue name

### Optional Integrations
- `STRIPE_SECRET_KEY` - Stripe API key
- `SENDGRID_API_KEY` - SendGrid API key
- `GOOGLE_CLOUD_API_KEY` - Google Cloud API key
- `NEVER_BOUNCE_API_KEY` - NeverBounce email validation
- `SCREENSHOTMACHINE_API_KEY` - Screenshot Machine API

## API Endpoints

The API provides various endpoints under `/api/`:

- `/api/agents/*` - AI agent management and commands
- `/api/conversation` - Team conversation coordination
- `/api/workflow/*` - Workflow orchestration
- `/api/integrations/*` - Third-party integrations
- `/api/ai/*` - Direct AI communication
- `/api/site/*` - Site analysis and management

See the `docs/` folder for detailed API documentation.

## Architecture

- **Framework**: Next.js 15 with App Router
- **Language**: TypeScript
- **Database**: Supabase (PostgreSQL)
- **Workflow Engine**: Temporal
- **Real-time**: WebSocket support
- **Testing**: Jest with ts-jest

## Documentation

Internal architecture, integration guides, and historical implementation
notes are indexed in [`docs/README.md`](docs/README.md). Start with the
dated code-agent harness checkpoint for the current execution architecture.

## Development Tips

1. **Port Configuration**: The server runs on port 3001 by default. Change via environment variables or modify `package.json` scripts.

2. **CORS Configuration**: CORS settings are managed in `cors.config.js`. Update this file for production domains.

3. **Temporal Workers**: For full workflow functionality, ensure you have a Temporal worker running that can execute the workflows defined in `src/temporal/` and `src/lib/workflows/`.

4. **Environment Files**: Use `.env.local` for local development. This file is gitignored and should not be committed.

## Troubleshooting

### Temporal Connection Issues
- Ensure Temporal server is running: `temporal server start-dev`
- Check `TEMPORAL_SERVER_URL` matches your Temporal instance
- Verify firewall allows connections to Temporal port (default 7233)

### Supabase Connection Issues
- Verify `NEXT_PUBLIC_SUPABASE_URL` is correct
- Ensure `SUPABASE_SERVICE_ROLE_KEY` has proper permissions
- Check network connectivity to Supabase

### WebSocket Issues
- Ensure WebSocket server is running: `npm run ws`
- Check that ports are not already in use
- Verify CORS configuration allows WebSocket connections

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

```
Copyright (C) 2024 Uncodie

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

## Contributing

Contributions are welcome! Please ensure your code follows the project's coding standards and includes appropriate tests.

## Support

For issues, questions, or contributions, please refer to the project's issue tracker or documentation in the `docs/` folder.
