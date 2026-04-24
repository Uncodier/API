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
   - For text-to-image generation, use integrations like **FAL AI** (e.g., `fal-ai/recraft-v3` model) or **Pollinations**.
   - For video editing and content search, use **Video Editor** (Video Jungle API).
2. **Effective Prompting:** Be specific and descriptive. Include details about style, colors, composition, lighting, and the main subject. For SVGs, specify the style (flat design, isometric, icon, detailed illustration) and request clean, scalable code. For photorealistic images, specify lens type, camera angle, and lighting conditions.
3. **Code Integration:**
   - When generating SVGs directly in code (e.g., React components), ensure they are responsive (use `viewBox` instead of fixed `width`/`height`).
   - Optimize generated SVGs by removing unnecessary tags, grouping elements logically (`<g>`), and using CSS classes for repetitive styles.
   - When using AI-generated image URLs (e.g., from Pollinations), handle loading states and errors (fallbacks) properly in the UI.
   - Always provide descriptive alternative text (`alt`) for generated images to improve accessibility.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_write_file` | Save generated SVGs or integrate image URLs into components. |

## Artifacts
- **Produces**: SVG components, image URLs, and integrated media assets.
- **Consumes**: `requirement.instructions` (visual asset specifications).
