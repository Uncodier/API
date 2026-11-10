---
name: motion-design-html
description: Creates and reviews HTML/SVG/Canvas 2D and Three.js 3D motion graphics, animations, diagrams, animated charts and code-authored explainer videos with storyboard, art direction, deterministic timing and honest delivery. Use for diseño, diseños, animación, animaciones, explicativos, vídeos, video, gráficos, diagramas, infografías, HTML, GSAP, HyperFrames, MP4 and motion design; not ordinary UI hover effects or generative footage.
types: ['design', 'develop', 'content', 'marketing_campaign']
---

# HTML motion design and visual explainers

## Objective

Produce clear, visually intentional 2D/3D explanations and motion graphics, from brief through verified delivery. Prefer HTML/SVG for readable 2D graphics and Three.js only when depth explains something. Use HyperFrames as the preferred HTML-to-video authoring model when its runtime is available and authorized. This self-contained playbook does not install libraries, provide a renderer, or authorize billable services.

## Instructions

1. **Resolve the output and execution boundary before writing.**
   - Identify audience, the one idea to communicate, language, source facts, brand, duration, aspect ratio and requested output. Reuse supplied values. Ask one focused question only when an unresolved choice materially changes the result; otherwise state reasonable defaults.
   - Distinguish: interactive/replayable HTML; timed HTML composition intended for export; rendered MP4; generative footage. Do not substitute a download for a hosted preview, or an HTML file for a video.
   - Advice or comparison alone does not authorize implementation. Preserve user-selected skills and restrictions. A host **UI OUTPUT CONTRACT** remains binding, including required generate_video calls and text-node media restrictions. Explain conflicts rather than silently routing around them.
   - Read project metadata, existing files and available tool schemas. Use the current authorized writable workspace; requirement-owned work stays with its owner. A skill never grants write, deploy, network, account or billing permissions.
   - HyperFrames, GSAP, Three.js and Remotion are not guaranteed to be installed. Prefer dependencies already present. Do not add them to the backend API merely to author an artifact. Any authorized dependency change belongs in the target project with pinned versions and its lockfile.

2. **Set a concrete art direction, not a collection of effects.**
   - Read the brand and real assets first. Load ui-ux-design through skill_lookup when a broader visual system is needed; adapt its interface advice to the film, not a landing-page template.
   - Specify exact background/foreground/accent colors, typography roles, spacing, stroke weights, shape language and illustration style. Pick one visual thesis tied to the subject, rather than default gradients, glass cards or neon blobs.
   - Establish a focal point per shot. Match contrast and type size to the actual viewing size; do not assume a 1080p frame will be watched full-screen. Keep critical copy away from frame edges and platform overlays.
   - For a new video with no supplied format, propose 1920×1080 at 30 fps; preserve requested vertical/square formats. Interactive HTML should fit its container. Video frames retain a fixed composition, scaled proportionally rather than reflowed differently during export.
   - Use genuine product screens, logos and source data. Never invent metrics, quotes or scientific claims for visual polish. Label authorized illustrative data explicitly.

3. **Write the story and storyboard before detailed animation.**
   - State the takeaway in one sentence. Start from a recognizable problem, work through one concrete example and finish with its answer. Avoid a disconnected tour of features.
   - Record a compact shot table: scene id, start/end seconds, learning goal, on-screen copy, visual action, narration/asset needs and transition. Keep it in the project design notes or the existing step output; do not require a separate planning workflow for a small task.
   - Explain by showing a transformation: an input traverses a system, a diagram gains one part at a time, a comparison exposes a difference, or a cutaway reveals a mechanism. Do not turn every scene into three cards, bullets or decorative icon circles.
   - Put labels next to the component they identify; use leader lines when necessary. Keep the viewer oriented across cuts with a shared object, location or visual continuity.
   - Give text enough reading time and key results a deliberate hold. Derive timing from actual narration when present, not arbitrary 150–300 ms UI-transition rules. Do not generate voice, music or captions unless requested or clearly part of the accepted brief.

4. **Choose the simplest suitable drawing and animation technique.**
   - HTML + CSS + inline SVG: labels, typography, diagrams, charts, paths and most 2D explainers. Use viewBox, logical SVG groups and real text rather than rasterized labels.
   - CSS/Web Animations: lightweight browser-only effects. Provide pause/replay and a reduced-motion/static equivalent. A browser animation is not automatically export-safe.
   - GSAP: coordinated timelines when already supported by the project. Centralize timing instead of scattering independent tweens or timers. Prefer transforms/opacity for DOM movement; animate SVG paths where the explanation calls for it and profile the cost.
   - Canvas/Pixi: dense 2D particles or simulations when DOM/SVG becomes unsuitable. Keep accessible explanatory text in the DOM and separate the simulation state from drawing.
   - Three.js: depth, spatial relationships, a real product or mechanism. Do not use 3D solely to make text spin. Load webgl-threejs-pixi for performance guidance, but use the deterministic timing rules below instead of an uncontrolled game loop during export.
   - Existing Remotion project: retain its framework and drive visuals from useCurrentFrame; do not migrate it to HyperFrames without a reason. Check current API and commercial licensing before adding Remotion to an automated product.

5. **Make time explicit and reproducible.**
   - Every scene needs a defined start, end and initial/final state. One master time drives scene visibility, diagrams, camera, particles and labels. Expose a seek mechanism appropriate to the chosen runtime.
   - The same time must give the same visible state, even when seeking backwards or rendering frames out of order. No wall-clock Date.now(), unseeded Math.random(), accumulating frame deltas, asynchronous fetches during frame capture or infinite repeats in exportable scenes.
   - Preload fonts, images, models and shaders before declaring the composition ready. Freeze source data for the render. Seed generated variation; precompute simulations or evaluate them analytically at time t.
   - Keep browser playback scheduling separate from render(t): requestAnimationFrame may drive preview, but render(t) must not depend on how many preview frames have run.
   - A browser preview should expose play/pause, restart and seeking where appropriate, with keyboard operation and no autoplay sound. Respect prefers-reduced-motion with a readable static or reduced-motion mode; do not silently remove the motion requested for a video export.

6. **Use the HyperFrames contract only in a HyperFrames project.**
   - Confirm the installed version and its CLI help/docs before using version-sensitive APIs. Author a root index.html, scene compositions and local assets; use stable ids and editable text/color/media values. Do not require a desktop app or a provider account for a local deliverable.
   - Define the root composition id, duration, dimensions and fps. Timed clips use class="clip", data-start and data-duration in seconds; their interval is [start, start + duration). Track index organizes the editor; z-index controls paint order.
   - Each composition registers its paused GSAP timeline in window.__timelines under its composition id. Do not create a second autonomous clock or seek/play audio and video manually; let the runtime synchronize media.
   - Animate a child rather than tweening display/visibility/autoAlpha on the clip wrapper. Avoid having CSS and GSAP both own a transform on the same element.
   - Give audio elements stable ids. Keep fonts and media local with relative assets paths; ensure fonts resolve before review. Do not embed tokens or authenticated asset URLs in a distributable file.
   - For a Three.js/Canvas scene, use the installed runtime's hf-seek integration to draw at the requested time and its build-ready mechanism for asynchronous setup. Verify the event payload against that version; do not guess adapter APIs.
   - A composition that requires a runtime is not a self-contained offline HTML. Package its dependencies through an authorized project delivery path or disclose what is required. Do not paste only a root file and claim the project is complete.

7. **Direct the 3D scene as an explanation.**
   - Define a hero object, meaningful camera shots, focal length, key/fill/rim lighting, environment, materials and contact shadows. Choose light/materials to reveal shape, not to hide weak geometry behind bloom.
   - Use cutaways, exploded views or a guided camera move to explain relationships; retain orientation cues. Put readable labels in screen space and avoid obscuring the feature being described.
   - Drive camera and object transforms from master time. Wait for GLTF/GLB loading and shader readiness. Validate the target browser's WebGL support and render backend instead of assuming GPU availability.
   - Bound pixel ratio, texture sizes, geometry and draw calls. Reuse geometry/materials and dispose resources. Profile the heaviest shot. Provide a truthful 2D/static fallback when appropriate, without claiming a 3D result that did not render.

8. **Validate content, still frames and motion before delivery.**
   - Check the facts, arithmetic, labels and logical sequence against the source. Confirm copy fits, fonts/assets load, contrast is readable and no unintentional clipping or overlap occurs.
   - Inspect at least the beginning, middle and end of each scene, plus transition boundaries. Play through the whole sequence to catch bad pacing, abrupt camera cuts, flicker, missing holds and audio drift; still screenshots alone cannot prove temporal quality.
   - Test forward/backward seeking and repeated rendering of selected timestamps. Test the intended viewport, keyboard controls and reduced-motion behavior for interactive HTML.
   - Use available browser/screenshot tools and inspect their output; a successful build is not a visual review. Batch fixes, then make one confirmation pass within the existing task budget. Report unchecked items rather than inventing evidence or launching an unbounded polish loop.
   - In an installed HyperFrames project, use its lint/check commands, inspect sampled snapshots and verify reported checks actually ran. Confirm exact flags with the pinned CLI's help. Do not invoke upstream telemetry, feedback beacons, cloud rendering or promotional integrations as part of this skill.

9. **Render and deliver honestly.**
   - Export only when requested or part of the agreed output. First check renderer, browser, FFmpeg/ffprobe, permitted execution time, asset access, disk and a binary upload/delivery capability in the actual execution environment.
   - Render in the authorized project execution environment, not inside an API request handler. If render or binary delivery is unavailable, state the blocker and offer the authored project/HTML when useful; do not substitute generate_video or claim MP4 success.
   - For a real video, verify nonempty output, codec/container, dimensions, fps, duration, audio when requested, and decoded frames from the exported file. Return only an actual authorized artifact URL/receipt. Never rename HTML as .mp4 or send a binary through a text-only tool.
   - For a small downloadable HTML, load file-delivery and discover deliver_file via tools. It accepts UTF-8 up to 262144 bytes, not MP4; its private authenticated download is not a public deployment. Include every necessary asset inline only when compatible with that limit and permitted licensing. Never split or encode a binary to bypass it.
   - Report output type, duration/format where applicable, actual artifact location, checks performed, unresolved limits and whether preview/render was verified. Preserve editable source and real delivery receipts; never claim a tool ran merely because commands appear in documentation.

## Tools

Use only tools actually exposed to this turn, with their current schemas. Not every execution mode has a writable workspace or browser.

| Tool | When to use |
| --- | --- |
| `skill_lookup` | Load ui-ux-design, webgl-threejs-pixi or file-delivery as needed. |
| `tools` | Discover and describe available asset, browser, delivery and other routed capabilities. |
| `read_files`, `list_files`, `search` | Inspect an assistant workspace and dependency metadata when exposed. |
| `apply_patch`, `exec` | Author and validate only in a confirmed writable assistant workspace. |
| `sandbox_read_file`, `sandbox_write_file`, `sandbox_run_command` | Equivalent project operations when the authorized runner exposes sandbox tools. |
| `sandbox_capture_screenshots`, `sandbox_visual_critique` | Inspect rendered scenes when available; supplement with playback/seek checks. |
| `deliver_file` | Deliver supported small UTF-8 HTML documents with actual private download/Git receipts, never binary video. |

## Artifacts

- **Produces**: editable HTML/SVG/Canvas/Three.js composition and required local assets; storyboard and visual/timing specification in project notes or step output; visual/temporal verification evidence; an MP4 only after an available renderer and binary delivery path succeed; otherwise truthful HTML/project delivery and limitations.
- **Consumes**: user brief, requirement.instructions, brand/source facts, approved assets, existing project dependencies, selected skills, host output contract and execution permissions. Does not alter ownership or the host's media contract.

## Sources and adaptation

This Makinari-authored procedure is informed by the HTML-to-video, deterministic timing and review concepts in [HyperFrames](https://github.com/heygen-com/hyperframes) and its official [agent skill](https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/SKILL.md), published under Apache-2.0. It is an integration playbook, not a vendored runtime or a verbatim skill bundle. Upstream plugin hooks, telemetry, account flows and desktop promotion are intentionally not adopted. All essential task guidance is included above; external links are optional API/source references, not missing local instructions.