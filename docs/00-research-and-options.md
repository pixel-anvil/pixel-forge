# Pixel art + animation tool — Research & implementation options

Status: **DRAFT, awaiting decision** (2026-10-26). Working name "pixel-forge" (placeholder).
Next step after a decision: `01-spec.md` → spec review → `02-plan.md` → plan review.

---

## 1. Requirements as understood

| # | Requirement | Notes |
|---|---|---|
| R1 | Draw pixel art (layers, frames, tools) | Table stakes |
| R2 | Animate (timeline, onion skin, tags, frame durations, export) | Table stakes |
| R3 | Limit colours to a palette set | Indexed mode, preset palettes (PICO-8, NES, GB, Lospec import) |
| R4 | Convert a real image into a pixel sprite | Downscale + quantize + clean-up |
| R5 | Limbs / rigs / layers to make animation easier | The differentiator |
| R6 | LLM integration (Claude etc.), MCP server, prompt-driven animation | The second differentiator |
| R7 | Godot integration, possibly 2D sprite on a 3D object (2.5D) | Matches the user's existing Godot projects (GAME_NOTES §1, local) |
| R8 | Best practices, reviewable architecture, multi-session buildable by mixed-cost models | Drives the choice of language and structure |

Observed context: you already make sprites **in code** (small scripts; GAME_NOTES §1, local).
You have Godot 4.6.1 with an editor MCP addon, a self-built Aseprite (EULA: personal use, no
redistribution), LibreSprite.app, and the `pixel-plugin` Aseprite MCP. That suggests the tool's
first user is **you, making assets for a Godot game, with Claude in the loop**.

---

## 2. Similar tools (what exists)

### Editors
| Tool | Licence / stack | Relevant strengths | Gaps vs. our goals |
|---|---|---|---|
| **Aseprite** | Proprietary (source available; no redistribution), C++ | Best-in-class editor UX, Lua scripting API, WebSocket client in Lua (v1.2.30+), plugin file formats (1.3.18) | No bones/rigging; Lua can't draw custom overlays on the main canvas well; Lua WebSocket is **client only** |
| **LibreSprite** | GPLv2 fork of Aseprite from 2016, C++ | Free, redistributable, optional JS scripting | Low activity, old codebase, heavy C++ build; a fork means maintaining a large C++ app |
| **Pixelorama** | MIT, **built in Godot** (GDScript) | Active, extensions API, tilemap layers, **3D layers**, exports Godot TileSets; the **Skeletor** extension adds bones, FABRIK/CCD IK, tweening | Skeletor: no undo for bone actions, one pose layer; extension API docs incomplete |
| **Piskel / Lospec editor** | Web | Simple, browser | Basic; no rigging/AI |
| **Pixanima** | Web, freemium | AI sprites/tiles/palettes, AI re-pose, **AI in-betweening** | Closed, credit-based, early |

### AI / rigging
| Tool | What it does | Lesson |
|---|---|---|
| **PixelLab** | Diffusion models for pixel art, **skeleton-guided animation**, 4/8-direction rotation, Aseprite extension | Bones are a useful **control signal** for AI, not only for transforms |
| **Retro Diffusion** | Pixel-art diffusion model + Aseprite extension + cloud API | Image *generation* needs a diffusion model; Claude can't output raster images |
| **spine-animation-ai** | Claude skill that builds Spine skeleton JSON + animations from reference images | LLMs are good at producing **structured pose/keyframe data** |
| **Aseprite MCPs** (pixel-mcp, diivi/aseprite-mcp 104 tools, a TS one with live mode) | Claude drives Aseprite via generated Lua | Proven demand; big flat tool lists; every one needs a licensed Aseprite |
| **LibreSprite-MCP** | Runs JS inside LibreSprite through a remote-script proxy | Single-script-at-a-time bridge; fragile |
| **godot-ai** and many Godot MCPs | MCP → live Godot editor over WebSocket | Pattern: editor plugin + sidecar MCP server + WebSocket bridge |

### Image → pixel sprite algorithms
- Resample-based: area-average or k-centroid downscale to a target size, then **palette quantization**
  (k-means++ or median-cut in a perceptual space like OKLab/CIELAB), optional ordered or Floyd–Steinberg dithering.
- Grid-detection based (Pixel Snapper, MIT; RepairAI): detect the off-grid "fake pixels" in AI images and snap them to a real grid. This works better for AI output.
- Post-processing: background removal, outline generation, orphan-pixel cleanup, palette mapping.
- All of this is **deterministic code**. The LLM's role is choosing parameters, critiquing with vision, and fixing up the result.

### The rigging problem specific to pixel art
Rotating pixel art by non-90° angles blurs it (bilinear) or makes it jagged (nearest). Known mitigations:
1. **RotSprite-style rotation** (upscale ×8 with edge-aware scaling, rotate, downsample). Rust/CLI implementations exist (`rotsprite`, `spriterot`).
2. **Sprite swaps**: each limb has several hand-drawn variants (angles, open/closed hand). The rig picks a variant instead of rotating. This is what good pixel cutout animation does.
3. **Bake and touch up**: the rig produces frames, then the artist (or the LLM) cleans the pixels. The tool keeps the clean-ups as per-frame overrides, so re-posing doesn't destroy them.
4. Integer-snapped translation and pivots at joint pixels.
A good pixel rig supports all three: rotate when it's acceptable, swap when it isn't, and override by hand when needed.

### Lumina (gitlab.com/stubborn-hug/lumina)
The repo is **"Luminati"**, a three.js HD-2D-style 2.5D pixel engine (MIT, created 2026-10-05). It is **not an
LLM protocol**. What's worth copying is its *agent-friendly architecture*:
- **Typed automation hooks** (`window.__editor.state.addObject`, `begin/commit`, `undo`, `snapshot()`), so the UI and agents drive the same command surface. Contract changes are additive only.
- **A headless check harness** (`npm run check --script=actions.json`) that runs JSON action scripts and writes `report.json` and **screenshots**. The agent verifies its own work visually.
- **Agent onboarding docs** (`AGENT_ONBOARDING.md`, KNOWN_ISSUES, task playbooks, a "code wins over docs" rule) designed for **sessions that start with no context**. This fits a multi-session, multi-model build exactly.
- Its 2.5D renderer (lit pixel sprites in 3D) is also a reference for R7.

**Takeaway:** the "communication layer" should be (a) one typed command API used by the UI, the CLI and the MCP server,
(b) render-to-PNG feedback so the LLM *sees* the result, and (c) a scripted, headless verification harness.

### UI research — what good pixel/animation UIs share
- **Layout (Aseprite convention, widely copied):** tools on the left, a big canvas in the centre with a nearest-neighbour zoom and pixel grid, palette and colour on the left or right, **timeline at the bottom with layers as rows and frames as columns**, and cels as cells. Tags shown as coloured ranges over the frame header.
- **Onion skin:** range brackets on the timeline (Flash/Pencil2D proposal), a master opacity, and prev/next tint colours. Toggle with one key.
- **Keyboard-first:** single-key tools (B, E, G, M…), `,`/`.` for frames, Enter for play. Shortcuts are remappable.
- **Live preview pane:** a separate small window that loops the current tag at 1×/2×.
- **Rig mode** (from Spine/DragonBones/Skeletor): bones drawn as an overlay, a hierarchy tree panel that mirrors the layer panel, pose mode vs. setup mode, IK handles, and auto-key on the timeline.
- **AI panel:** a chat or prompt panel with the results placed **as new layers or frames, never destructively**, plus accept/reject and a diff view. Every AI action is one undo step.
- Dark theme by default and integer UI scaling for crisp pixels.

### Framework research (for a greenfield build)
| Choice | Verdict |
|---|---|
| **TypeScript** core | LLMs (including Sonnet/Haiku) are most reliable in TS. Strict types and Vitest give cheap models guard-rails. The official MCP TS SDK is first-class. |
| Rendering: **Canvas2D + ImageData** (WebGL later if needed) | Sprites are tiny (≤512²). Canvas2D is enough and works headless in Node via `@napi-rs/canvas` or pure-buffer compositing. |
| UI: **React** (or Solid) | React has the best LLM familiarity. The canvas is drawn imperatively anyway, so React only renders the panels. |
| Desktop shell: **browser first**, then **Tauri 2** or **Electron** | Tauri is smaller but uses WebKit on macOS. Electron gives consistent Chromium and in-process Node (the MCP server can live inside it). Defer the choice; start as a local web app served by the tool itself. |
| Godot/GDScript app (like Pixelorama) | Viable. One codebase for the standalone app and an in-editor plugin. But testing, headless runs and the MCP SDK are weaker, and it duplicates Pixelorama. |
| C++ (Aseprite/LibreSprite fork) | Slowest to change, most expensive for agents to work in, licence problems (Aseprite) or a stale base (LibreSprite). |

---

## 3. Implementation options

### Option A — Aseprite extension + MCP server ("build on Aseprite")
Lua extension for the rig and palette features, plus an external MCP server (TS/Python) bridged over the Lua WebSocket client.
- ✅ Best editor UX on day 1, zero drawing-tool work. Several MCPs to learn from.
- ❌ Rigging UI is painful in Lua dialogs (no proper bone overlay on the canvas). Every user needs a paid or self-built Aseprite. You can't redistribute a bundle. You're bounded by API limits forever.
- Effort: **S–M**. Ceiling: **low** for rigging.

### Option B — Fork LibreSprite
- ✅ Open (GPLv2), a full editor already exists.
- ❌ Large 2016-era C++ codebase, low upstream activity, slow builds. Agent work on it is expensive and error-prone. The GPL is viral for your additions.
- Effort: **L**. **Not recommended.**

### Option C — Pixelorama extension or fork (Godot-based, MIT)
Add a rig extension (or extend Skeletor) and an MCP sidecar bridged by WebSocket (the godot-ai pattern).
- ✅ MIT, active project, Godot-native export, 3D layers already exist, and GDScript is easy.
- ❌ Bound to their architecture and extension API (incomplete docs). A fork means tracking upstream. Headless, testable rendering for the LLM loop is awkward. Their document model isn't designed for rigs.
- Effort: **M**. Ceiling: **medium**.

### Option D — Greenfield, headless-core TypeScript app ⭐ *recommended*
A pure TS **core library** (document model, commands and undo, palette, quantize, rig, RotSprite, renderer),
reused by:
1. a **CLI** (`forge render`, `forge convert`),
2. an **MCP server** (tools, resources, PNG previews back to the LLM, a session-scoped live link),
3. a **web editor UI** (React plus a canvas, served locally by the same process, later wrapped in Tauri or Electron),
4. a **Godot plugin** (GDScript importer: `SpriteFrames`, `AnimationPlayer`, an optional `Sprite3D` billboard setup for 2.5D),
5. optional **.aseprite import/export**, so you can still touch up pixels in Aseprite.
- ✅ Full control over the rig model (the differentiator). Headless from day 1, so Claude Code can use it **before the UI exists**, matching how you already work. Highly testable. Cheap-model friendly. Lumina-style harness built in.
- ❌ The editor basics (tools, selection, timeline) have to be built. This is the largest UI effort, but it's well understood and splits easily into small tasks.
- Effort: **L**, but it **delivers value incrementally**: core and MCP are usable early, the UI comes later.

### Option E — Greenfield in Godot (app + plugin from one codebase)
- ✅ Native Skeleton2D, trivial 2.5D preview, ships as both a standalone app and an editor plugin.
- ❌ Weaker testing and headless story. The MCP server still needs a sidecar. GDScript is less type-safe for cheap models. Largely re-builds Pixelorama.
- Effort: **L**.

### Option F — Godot plugin only (draw elsewhere, rig and animate in Godot)
- ✅ Smallest scope. Uses the Godot AnimationPlayer and the existing godot-ai MCP.
- ❌ Godot's Skeleton2D rotation is not pixel-art aware. You'd still need a separate editor. No palette or convert features. Animation lives in the engine, not as an art asset.
- Effort: **S**. Doesn't meet R1–R4.

### Comparison
| | A Aseprite ext | B LibreSprite fork | C Pixelorama ext | **D TS headless core** | E Godot app | F Godot plugin |
|---|---|---|---|---|---|---|
| Time to first useful result | ★★★ | ★ | ★★ | ★★ (CLI/MCP early) | ★ | ★★★ |
| Rigging quality ceiling | ★ | ★★ | ★★ | ★★★ | ★★★ | ★ |
| LLM/MCP integration | ★★ | ★ | ★★ | ★★★ | ★★ | ★★ |
| Testability / cheap-model friendliness | ★ | ★ | ★★ | ★★★ | ★★ | ★★ |
| Licensing freedom | ✗ | GPL | MIT | yours | yours | yours |
| Godot / 2.5D | via export | via export | ★★★ | ★★ (plugin) | ★★★ | ★★★ |

---

## 4. Recommendation

**Option D**, phased so every phase is usable on its own:

| Phase | Deliverable | Usable for |
|---|---|---|
| P0 | Repo, architecture docs, ADRs, agent onboarding, CI | — |
| P1 | Core: document model (layers, frames, cels, tags, palettes), command/undo bus, compositor, PNG/GIF/spritesheet export, palette presets and quantization | Scripting sprites like today, but structured |
| P2 | **Image → sprite converter** (downscale, quantize in OKLab, dithering, grid-snap, outline/cleanup) + CLI | R3, R4 |
| P3 | **MCP server** (tools + resources + preview images + a verification harness) | Claude Code drives everything headlessly |
| P4 | **Rig system**: bones, parts-from-layers, pivots, poses/keyframes, IK, RotSprite, sprite swaps, bake with overrides | R5 + "animate with prompts" via MCP |
| P5 | **Web editor UI** (canvas, tools, timeline, onion skin, palette, rig mode, AI panel); a live link where MCP edits appear live in the UI | R1, R2 |
| P6 | **Godot plugin** (importer, 2D AnimatedSprite2D, 2.5D Sprite3D billboard) + .aseprite interop | R7 |
| P7 | Optional image-generation providers (OpenAI / Gemini / Retro Diffusion / PixelLab API) behind a provider interface; desktop packaging | Text → sprite |

**A cheaper alternative if you want results sooner:** do P1–P4 of D (headless core + MCP + rig), and use
**Aseprite (via .aseprite export/import) as the hand-editing UI** for now. Then decide on P5 once the rig proves itself.
This is a ~40% smaller first milestone.

### Points I want to challenge
1. **"Claude generates pixel art"**: Claude can't produce raster images. It can (a) place pixels via tools (fine for ≤32² sprites, as with your pxl workflow), (b) produce **pose data** for the rig (its strongest contribution), (c) choose converter parameters and critique results via vision. Text → image needs a diffusion provider (paid API). Should that be in scope?
2. **Rigging vs. pixel quality:** pure bone rotation will look "off" at 32–64 px. The plan therefore treats sprite swaps and bake-and-touch-up as first-class features, not afterthoughts.
3. **2.5D:** a 2D rig doesn't automatically give 4/8-direction views. In 2.5D Godot a billboarded `Sprite3D` with per-direction animations is the standard technique. We'd export directions as separate tags (drawn or rig-mirrored), not generate them.
4. **Scope:** a full editor plus rig plus MCP plus Godot is a multi-month hobby project. The phasing above keeps every step useful.

---

## 5. Lessons from the existing in-house pipeline (what NOT to inherit)

Source facts: GAME_NOTES §3 (local).

| Pitfall in a typical hand-rolled pose tool | Root cause | How pixel-forge avoids it |
|---|---|---|
| Moved parts tear and leave gaps | Parts are **cut out of flat frames**, so there are no hidden pixels under the joints | Parts are authored as **separate layers with overdraw (joint caps)**. The tool flags uncovered joints. |
| Sleeves are always drawn under the shirt | Fixed draw order | **Draw order is a per-frame, keyable property** |
| Shirt warped by four corners | Image warping resamples pixels and creates artifacts | **No warps in v1.** Use sprite-swap variants instead, and rotate only with RotSprite. |
| Undo is per move, but base rigs are shared | Split histories over shared data | **One document, one undo history.** The rig is shared by every animation in the document. |
| Pipeline needs a drawing script → importer → Godot import, with mappings rewritten on save | Data spread across many JSON files plus a game-specific importer | **One document file.** A Godot import plugin re-imports it automatically on save. |
| Game concepts (prop-attachment marks, per-frame vertical offsets, erase flags) live in the art tool | No line between art and game | Generic **markers** (named points per frame), a **root-motion** track and **events**. The game interprets them. |
| Limbs drawn by code lines → uneven stair-steps | Procedural limb rendering | Limbs are drawn pixels (by hand, by the LLM through tools, or converted from images), not procedurally generated |
| Monolithic single-page tool | No architecture | A layered architecture with a typed command bus and tests |
