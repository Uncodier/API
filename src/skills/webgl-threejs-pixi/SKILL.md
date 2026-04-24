---
name: webgl-threejs-pixi
description: Optimizes performance, memory management, and rendering for WebGL, Three.js, React Three Fiber, and Pixi.js applications.
types: ['develop', 'design']
---

# SKILL: webgl-threejs-pixi

## Objective
Develop and optimize advanced graphics, games, and simulations using WebGL libraries (Three.js, React Three Fiber, Pixi.js). Focus on performance, memory management, and efficient rendering for both web and mobile platforms.

## Instructions
1. **Performance Optimization:** Minimize object creation during the game loop to reduce garbage collection pauses. Use **Object Pooling** for frequently created/destroyed objects (e.g., bullets, particles). Implement **Texture Atlases** (Sprite Sheets) to reduce draw calls. Use **InstancedMesh** (Three.js) or **ParticleContainer** (Pixi.js) for rendering many similar objects.
2. **Scene & Memory Management:** Manage the scene graph properly by removing unused objects. Implement **Frustum Culling** for off-screen objects. Explicitly free resources (`dispose()`) for geometries, materials, and textures to prevent WebGL memory leaks. In React Three Fiber, use `useFrame` carefully and avoid updating React state inside it (mutate refs directly).
3. **Specific Tools:**
   - **Three.js / R3F:** Use optimized formats like GLTF/GLB with Draco or Meshopt compression. Use `@react-three/drei` for common utilities.
   - **Pixi.js:** Use the WebGPU renderer for optimal performance on supported browsers, with a fallback to WebGL.
4. **Mobile Considerations:** Be mindful of scene complexity and polygon/vertex count. Implement progressive asset loading. Use the library's native ticker to ensure consistent updates synchronized with the monitor's refresh rate.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_read_file` | Read existing WebGL/Canvas components to identify optimization opportunities. |
| `sandbox_write_file` | Implement optimized 3D/2D rendering logic. |

## Artifacts
- **Produces**: High-performance WebGL/Canvas components and game loops.
- **Consumes**: `requirement.instructions` (graphics specifications and performance targets).
