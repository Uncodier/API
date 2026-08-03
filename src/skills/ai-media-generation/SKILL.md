---
name: ai-media-generation
description: Generates images, SVGs, and videos using AI and MCP servers, crafting effective prompts and integrating assets into the codebase.
types: ['design', 'content', 'integration']
---

# SKILL: ai-media-generation

## Objective
Create visual and multimedia assets by interacting with Artificial Intelligence tools via the Model Context Protocol (MCP). Craft effective prompts and properly integrate the generated assets into the application.

## Instructions
1. **MCP Server Usage:**
   - For vector graphics (SVG, PNG, WebP), use MCP servers like **SVGverseAI** or **SVGMaker**.
   - For text-to-image generation, prefer the Makinari public image endpoint before falling back to external tools like FAL AI or Pollinations.
   - For video editing and content search, use **Video Editor** (Video Jungle API).
2. **Effective Prompting:** Be specific and descriptive. Include details about style, colors, composition, lighting, and the main subject. For SVGs, specify the style (flat design, isometric, icon, detailed illustration) and request clean, scalable code. For photorealistic images, specify lens type, camera angle, and lighting conditions.
3. **Makinari Image Generation API (Preferred for UI embeds):**
   - Base URL (always absolute — this API lives on the Makinari backend, NOT on the app being built):
     `https://backend.makinari.com/api/public/image/prompt/[url_encoded_prompt]?width=1024&height=1024`
   - `prompt` must be URL-encoded. Optional `width` / `height` query params (default 1024).
   - Example:
     ```tsx
     <img
       src="https://backend.makinari.com/api/public/image/prompt/a%20futuristic%20cityscape?width=800&height=400"
       alt="Futuristic cityscape at sunset"
     />
     ```
   - Never use a relative `/api/public/image/prompt/...` path inside sandbox apps — that route does not exist there.
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
