---
name: ai-media-generation
description: Generates images, SVGs, and videos using AI and MCP servers, crafting effective prompts and integrating assets into the codebase.
types: ['design', 'content', 'integration']
---

# SKILL: ai-media-generation

## Objective
Create visual and multimedia assets by interacting with Artificial Intelligence tools via the Model Context Protocol (MCP). Craft effective prompts and properly integrate the generated assets into the application.

## Instructions
1. **Brand Guidelines First (MANDATORY):** Before generating ANY media, you MUST pull the company's **Brand Guidelines** (colors, typography, photography style, tone) from the orchestrator's instructions or `memories`. If none exist, deduce a cohesive visual identity based on the client's industry. NEVER generate generic "stock photo" style images.
2. **MCP Server Usage:**
   - For vector graphics (SVG, PNG, WebP), use MCP servers like **SVGverseAI** or **SVGMaker**.
   - For text-to-image generation, prefer the Makinari public image endpoint before falling back to external tools like FAL AI or Pollinations.
   - For video editing and content search, use **Video Editor** (Video Jungle API).
3. **Effective Prompting (Brand Injection):** Be specific and descriptive. You MUST inject the brand's exact aesthetic into the prompt (e.g., "incorporating deep blue and safety orange accents", "shot in a gritty, high-contrast industrial style", "flat vector illustration matching #FF5500"). For photorealistic images, specify lens type, camera angle, and lighting conditions that align with the brand.
3. **Makinari Media Generation API (Preferred for UI embeds):**
   - Base URL (always absolute — this API lives on the Makinari backend, NOT on the app being built). Use `image`, `icon`, or `video` in the path.
   - Images: `https://backend.makinari.com/api/public/image/prompt/[url_encoded_prompt]?width=1024&height=1024`
   - Icons: `https://backend.makinari.com/api/public/icon/prompt/[url_encoded_prompt]?width=256&height=256&bg=transparent` (Icons have no background by default, optionally pass a `bg` param like `bg=solid+white` or `bg=dark+blue`)
   - Video: `https://backend.makinari.com/api/public/video/prompt/[url_encoded_prompt]?duration=5&ratio=16:9`
   - `prompt` must be URL-encoded.
   - Example Image:
     ```tsx
     <img
       src="https://backend.makinari.com/api/public/image/prompt/a%20futuristic%20cityscape?width=800&height=400"
       alt="Futuristic cityscape at sunset"
     />
     ```
   - Example Icon:
     ```tsx
     <img
       src="https://backend.makinari.com/api/public/icon/prompt/a%20minimalist%20shopping%20cart%20outline?width=64&height=64&bg=transparent"
       alt="Shopping Cart Icon"
     />
     ```
   - Example Video:
     ```tsx
     <video controls autoplay loop muted>
       <source src="https://backend.makinari.com/api/public/video/prompt/a%20futuristic%20cityscape%20with%20flying%20cars?duration=8&ratio=16:9" type="video/mp4" />
     </video>
     ```
   - Never use a relative `/api/public/...` path inside sandbox apps — that route does not exist there.
   - Auth: the browser sends `Referer` from the preview/deployed hostname; that hostname must match `requirement_status.preview_url` or `endpoint_url`. Do not call this from curl/scripts without Origin/Referer unless the image is already cached.
4. **Code Integration:**
   - When generating SVGs directly in code (e.g., React components), ensure they are responsive (use `viewBox` instead of fixed `width`/`height`).
   - Optimize generated SVGs by removing unnecessary tags, grouping elements logically (`<g>`), and using CSS classes for repetitive styles.
   - When using AI-generated image URLs, handle loading states and errors (fallbacks) properly in the UI.
   - Always provide descriptive alternative text (`alt`) for generated images to improve accessibility.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_write_file` | Save generated SVGs or integrate image URLs into components. |

## Artifacts
- **Produces**: SVG components, image URLs, and integrated media assets.
- **Consumes**: `requirement.instructions` (visual asset specifications).
