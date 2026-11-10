# HTML motion design integration

## What is installed

`motion-design-html` is a bundled, self-contained agent procedure for art direction, storyboards, HTML/SVG 2D, Three.js 3D, deterministic timing, review and honest delivery. It adapts concepts from HyperFrames without importing its telemetry, account flows or desktop promotion. The existing UI-animation and WebGL skills point to it for explanatory compositions.

The shared motion routing instruction covers conversational/workflow contexts and dedicated plan-step prompts (which replace the general prompt). The legacy direct-generation rule explicitly excludes code-authored animations. Generative footage continues to use `generate_video`; the host UI output contract and all workspace/tenant authorization remain unchanged. Required user-selected skills still apply.

Keyword lookup normalizes accents, preserves `2d`/`3d` and common short technical terms (`ui`, `ux`, `qa`, `ai`, `js`, `ts`, `db`), and deduplicates terms. Both the site-scoped lookup and bundled fallback use the same ranker on an already scoped pool. Bilingual metadata makes Spanish searches discoverable; this is not semantic translation.

## What is not installed

No HyperFrames, GSAP, Three.js, React Three Fiber or Remotion dependency is added to the API. No render worker, binary-upload endpoint, paid account, public deployment or cloud resource is provisioned. A skill supplies instructions, not execution capabilities.

An authorized target project may use its existing libraries and renderer. Adding a new runtime requires checking project ownership, current package documentation, pinned dependencies and licensing. Video rendering belongs in a suitable project execution environment, not a long-running API request. Small standalone HTML can use browser-native SVG/CSS/JavaScript without introducing a dependency.

`deliver_file` accepts UTF-8 documents up to 262144 bytes. It cannot upload MP4. A HyperFrames project with external runtime/assets is not a self-contained HTML download. The agent must identify those limitations and verify a real binary delivery path before promising exported video.

## Verification

Offline regression tests exercise real bundled metadata and skill loading, Spanish/accent and 2D/3D searches, type scoping, the tenant-scoped lookup tool, selection and prompt boundaries. Run:

```sh
node ./node_modules/jest/bin/jest.js --config jest.assistant-runtime.config.js --runInBand --runTestsByPath src/app/api/robots/instance/assistant/__tests__/motion-design-skill.test.ts
```

These tests do not demonstrate visual quality or install a renderer. Before enabling a production video-render capability, evaluate at least:

1. A source-grounded 2D explainer: progressive diagram, readable labels, verified scene timing and backward seeking.
2. A 3D mechanism/product: camera, lighting, asset readiness, deterministic seeking and target render-backend compatibility.
3. A narrated composition: actual audio duration, synchronization and decoded output frames after export.

For each, verify the requested artifact, fonts/assets, controls and reduced motion when interactive; for video verify dimensions, fps, duration, audio and actual download. Report missing capabilities instead of marking unexecuted checks as passed.