# Specialist models — Project Overview

## Problem
Some small models are tuned to do one narrow job well and nothing else. The first one we care about, [ccore/Qwen3.5-4B-GLB-3D-Coder](https://huggingface.co/ccore/Qwen3.5-4B-GLB-3D-Coder), writes a standalone Three.js HTML file that builds a low-poly asset and exports it as GLB. It is too small to drive a Code session, and the session's main model (Qwen3.8-Flash for Tim) is not trained to make 3D assets. Today there is no way for the main model to hand that job to the small model: `delegate` always runs the session's own model, and `make_asset` only makes 2D art.

The spike on 2026-11-01 (tmac1973/haruspex#906) showed the pairing works, but only with a check-and-repair loop around the small model: 8 of 15 prompts exported a GLB on the first try, the main model fixed all 7 failures in one round each, and about 9 of 15 results were usable when looked at.

## Goals
- The Code tab's main model can call a configured specialist model with one tool, `ask_specialist`, and get a useful result back.
- A specialist is a **kind** shipped in code plus a user-chosen endpoint and model. The kind supplies the default system prompt, the default sampling and the output handler. The user can override the prompt and sampling.
- New kinds can be added later by adding one module that registers itself, with no changes to the tool, the settings model or the settings UI beyond what the kind declares.
- Three kinds ship in the first release:
  - **`glb`**: sends the request, saves the HTML into the project, runs it headless, exports the GLB, verifies it, and returns the result.
  - **`threejs`**: for projects that are Three.js apps. Sends the request, saves the self-contained HTML scene at the given path, runs it headless with no export, checks it ran cleanly and drew something, and shows the main model a screenshot; the main model ports the scene into the project's code. The model that fits is [ccore/Qwen3.5-4B-3D-Coder](https://huggingface.co/ccore/Qwen3.5-4B-3D-Coder).
  - **`text`**: sends the request and returns the answer as text to the main model.
- The main model can send up to three reference images from the project with a request, to any specialist whose entry is marked "Accepts images" (its server has the model's vision projector loaded).
- When a GLB or Three.js check fails, the tool returns the errors and the path of the saved HTML. The main model fixes the HTML with its normal edit tools and calls `ask_specialist` again on that file to re-check and export.
- After a GLB exports, the main model sees a render of it when its model has vision. Without vision it gets mesh, triangle and animation counts and the size.
- The GLB kind keeps the HTML source in the project next to the GLB, so it can be repaired or re-exported later. The Three.js kind's output is the HTML itself.
- Requests to one specialist endpoint run one at a time unless the server advertises more slots.

## Non-goals
- Calling specialists from Chat, Shell, jobs or subtasks. Code tab only in this release.
- Downloading, installing or running specialist models. The user runs the server (llama-toolchest, Lemonade, llama-server or any OpenAI-compatible endpoint).
- A hidden repair loop inside the tool. Repairs happen in the open, by the main model.
- Regenerating with the specialist when the check fails, unless the main model chooses to call it again with a new request.
- A user-defined output handler. Handlers are code; users pick a kind.
- Saving a preview PNG into the project.
- Turning the Three.js kind's HTML into project modules automatically: the main model ports it.
- Fine-tuning, evaluating or ranking specialist models.

## Users & primary flow
The user is a developer working in the Code tab, for example on a Godot project.

1. In Settings → Code → Specialists, the user adds a specialist: picks the kind `glb`, gives it a name, an endpoint URL (and API key if needed) and a model id. The kind fills in the default system prompt and sampling; the user may change them. The user may mark it "on by default".
2. In a Code session, the session's specialist toggles show which specialists the session offers. A new session starts with the ones marked "on by default".
3. The user asks: "Make a mana potion GLB in assets/props/."
4. The main model calls `ask_specialist` with the specialist's name, the request and the output path.
5. The tool sends the request to the specialist endpoint, saves the HTML beside the target, runs it headless, triggers the export, saves the GLB, loads it back and renders it.
6. On success the tool returns the GLB path, the counts and the size, plus the render as a tool image when the model has vision. The main model checks the render and either accepts the asset or asks again with a better request.
7. On failure the tool returns the errors with their line numbers and the HTML path. The main model edits the HTML and calls `ask_specialist` again with that HTML file to re-check and export, without a new generation.

For the `threejs` kind the flow is the same, except that the output is the HTML scene itself at the given path, nothing is exported, and the check needs the page to run cleanly and draw something; the main model gets a screenshot and then ports the scene into the project's code. For the `text` kind, steps 5 to 7 reduce to: send the request, return the answer. With any kind, the main model may attach up to three reference images from the project when the specialist accepts images.

## Constraints
- Tauri 2 + SvelteKit 5 (runes), TypeScript, Rust 4-space/100-col; Prettier tabs, single quotes; `#lib/...` imports with extensions.
- Chat calls go through `src/lib/api.ts` (`chatCompletion`) with a `BackendOverride`; queueing through `withInferenceSlot` lanes keyed by base URL.
- Tool gating goes through `registry.ts` (`ToolFilterOpts`, `shouldIncludeCodeTool`), `codeTabProfile.ts` (`CODE_TAB_ONLY`, `isCodeWriteTool`) and `families.ts` for deferral.
- Code session config lives in the Rust-backed `CodeSessionRow`; adding fields means a migration and `./scripts/export-ipc-types.sh`.
- Settings are plain JSON in `AppSettings`; list records follow the `GenerationEntry` pattern (uuid id, name, url, `keyId`, model).
- The headless GLB run must work on Linux, Windows and macOS without asking the user to install anything.
- Specialist generations are slow (2–3.5 min and 8k–16k tokens per GLB in the spike), so the tool must report progress and honour cancel.
- A specialist endpoint may reject the webview's `Origin` header (CORS), as image servers do.
- UI copy: one short sentence per section, details in tooltips, full Settings paths.
- A user-visible change updates `docs/guide/` in the same PR.

## Success criteria
- A user can add a `glb` specialist pointing at asmodean's toolchest and a `text` specialist pointing at any OpenAI-compatible model, from Settings → Code → Specialists alone.
- In a Code session with a Three.js specialist on, the model card's four example scenes each end as an HTML file that runs cleanly, the main model sees a screenshot of each, and it can port one into a Vite + three project that builds.
- A specialist marked Accepts images receives a reference image the main model passes from the project; one not marked refuses it.
- In a Code session with the GLB specialist on, the 15 spike prompts each end with a valid GLB in the project, with the main model doing any repairs through `ask_specialist` re-checks, and no manual steps.
- A failing HTML returns every error the page raised, with its line number whenever the browser reports one (uncaught errors do; console errors, rejected promises, a missing export button and a timeout have none), and a re-check of the fixed file exports without a new generation.
- With a vision model, the main model receives a render of each exported GLB; without one, it receives counts and size.
- A session with the specialist toggled off never offers `ask_specialist`.
- Adding a third kind needs only a new kind module and its registration line; a unit test proves the registry drives the tool schema and the settings editor.
- Unit tests cover the kind registry, the tool's gating, request building, and the GLB result parsing; `npm run check`, `npm run lint`, `npm run test`, `cargo test` and `cargo clippy` pass.
- The guide has a page for specialists, and `code.md` points to it.

## Decisions
- **Where can the main model call a specialist?** → Code tab only.
- **How is a specialist defined?** → A kind shipped in code plus a user-chosen endpoint and model; the user can override the kind's prompt and sampling.
- **Ship a generic kind besides GLB?** → Yes, a plain `text` kind that returns the answer as text.
- **Who repairs a failing GLB?** → The main model, in the open: it edits the saved HTML and calls the tool again to re-check.
- **Who runs the specialist's server?** → The user's endpoint only; the app never downloads or starts specialist models.
- **How does a session pick its specialists?** → A global list in Settings, with a per-session toggle for each; new sessions start with the ones marked "on by default".
- **Does the main model see the exported GLB?** → Yes, as a render when it has vision; counts and size otherwise.
- **What does the GLB kind leave in the project?** → The GLB and its HTML source.
- **What does the Three.js kind leave in a native Three.js project?** → The verified standalone HTML at the given path, with a screenshot for the main model; the main model ports it into the project.
- **Can the main model send reference images?** → Yes, to any specialist whose entry is marked Accepts images; both 3D models can take images when the server loads the vision projector.
- **Where does the GLB's HTML run headless?** → A sandboxed, off-screen iframe on the existing `haruspex-artifact:` scheme in the main window, with an injected shim; hand-tested on all three OSes.
- **How is the exported GLB rendered for the model?** → The `three` npm package, bundled in a lazy chunk, rendering on an offscreen canvas in the app's webview.
- **What shape does the tool take?** → One `ask_specialist` tool: `name` (enum of the session's specialists), `request`, plus the params each kind declares.
- **Where does the GLB kind save the HTML source?** → Beside the GLB, as `<name>.glb.html`.
- **Where are a session's specialist toggles?** → A Specialists menu in the Code session header, one checkbox per specialist.
- **How do the phases land?** → One PR per phase.
- **How are specialist endpoints called?** → Through `src/lib/api.ts` with a `BackendOverride`, like remote chat backends; asmodean's toolchest answers the CORS preflight, so no Rust proxy is needed.
- **Who controls a specialist's thinking?** → The kind sets a default (off for `threejs`, the server's default for `glb` and `text`) and an entry can override it; sent as `enable_thinking`. Added after the 2026-11-02 spike, where the 3D-Coder model reasoned through 48k tokens without writing code.
- **Is `ask_specialist` deferred?** → No: it is in `CODE_CORE`, because it is offered only after the user turns a specialist on for the session.
