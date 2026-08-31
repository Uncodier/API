# Contributing to Makinari Docs

When contributing to the documentation in `src/content`, please follow the [Diátaxis framework](https://diataxis.fr/):

1. **Tutorials (Get Started)**: Step-by-step guides aimed at a concrete outcome for a specific user persona (e.g., Inbound, Outbound, MCP).
2. **How-Tos (Guides)**: Problem-oriented guides. "How to connect WhatsApp", "How to handle rate limits".
3. **Reference (API Reference)**: Information-oriented. Strictly defines endpoints, parameters, and payloads without narrative.
4. **Explanation (Concepts)**: Understanding-oriented. Diagrams and definitions of Sites, Requirements, and Auth models.

## Rules
- **Brand:** Use "Makinari" for all public-facing products. Use "Uncodie" only when referring to internal infrastructure or legacy CDN domains.
- **URLs:** Always use `https://backend.makinari.com` for the API and `https://app.makinari.com` for the dashboard.
- **Language:** English only.
- **Tone:** Professional, direct, and action-oriented.
- **Auth:** Always emphasize the dual auth model (CORS vs API keys).

To test docs locally:
```bash
npm run dev
```
Then navigate to `http://localhost:3001` (or your configured port).
