# Phase 05 — The asset spec: schema, parse, write, validate

**Depends on:** 04 (the spec embeds a `NormalizeProfile`) · **Enables:** 06, 07,
08, 09, 11 — everything that reads or writes the job's contract.

## Goal

Define and implement the one file that is the contract between a human, guided
planning and the asset job. It is JSON at a conventional path inside the user's
project, it lists every asset to produce, and it points at the anchor recipe.
This phase ships the schema, a tolerant parser, a stable writer, and validation
with errors good enough to act on — and nothing that generates anything.

## Files touched

- `src/lib/assets/spec/types.ts` — new. `AssetSpec`, `AssetEntry`, `AnchorRef`,
  `AnchorRecipe`.
- `src/lib/assets/spec/parse.ts` — new. `parseAssetSpec(json)` →
  `{ spec } | { errors }`.
- `src/lib/assets/spec/write.ts` — new. `renderAssetSpec(spec)` → stable JSON.
- `src/lib/assets/spec/validate.ts` — new. `validateAssetSpec(spec)` → problems.
- `src/lib/assets/spec/paths.ts` — new. The path conventions in step 4.
- `src/lib/assets/spec/*.test.ts` — new.

Note the module. This is asset-domain code and lives under `src/lib/assets/`,
not `src/lib/image/` — phase 01's layering test forbids the words `spec`,
`anchor`, `entry` and `asset` inside the backend module, and this file defines
all four.

## Steps

1. `AssetEntry`: `{ id: string; kind: 'sprite' | 'texture' | 'icon'; prompt:
   string; out: string; size?: number; seamless?: boolean; seed?: number | null;
   negativePrompt?: string; notes?: string }`.
   `size` overrides the profile's **`target_size` for this entry only**; the
   generation edge is derived from it exactly as phase 04 derives the default
   one, `MAX_GENERATION_EDGE` clamp included. `seed` pins this entry's seed so
   a single asset can be made reproducible; phase 10's retries still vary it,
   because a pinned seed that fails every check would otherwise retry
   identically forever. `notes` is documentation for whoever reads the file and
   is **never read by code** — stated here so it is not mistaken for an unused
   knob. `id` follows the same shape rule
   the dark_times content used (`^[a-z][a-z0-9_]{1,47}$`) so ids are safe as
   filenames and as content keys. `out` is a path relative to the working
   directory.
2. `AssetSpec`: `{ version: 1; style: { prompt: string; negativePrompt?: string;
   model?: string; loras?: LoraRef[] }; anchor: AnchorRef; normalize:
   NormalizeProfile; entries: AssetEntry[] }`. `style.prompt` is the suffix
   appended to every entry's prompt — one of the three coherence layers, and
   stored once; where both an entry and the style carry a `negativePrompt` the
   two are joined entry-first with `', '`, and phase 10's retry amendments are
   appended after both. `style.model` pins the checkpoint for the whole set so a re-run
   months later uses the same one; unset means the configured default.
   `style.loras` is the **only** source of LoRAs in this plan — phase 09
   degrades against `maxLoras`, and without a field here that degradation would
   have no input.
   There is deliberately no `style.backgroundColor`: the chroma key lives on
   `normalize.background.color` (phase 04) and that is the single source. Two
   fields would let a user edit one and silently break keying for every entry.
3. `AnchorRef`: `{ image: string; recipe: string }` — both paths relative to the
   working directory, defaulting to the constants in step 4. `AnchorRecipe` is
   also defined here, since it is spec-adjacent data rather than backend data:
   `{ version: 1; prompt: string; negativePrompt: string; seed: number; backend:
   string; model: string; sampler: SamplerSettings; loras: LoraRef[]; size:
   number; palette: number[]; createdAt: string }`. Every field is populated
   from `ImageResult.meta` plus the request that produced it, which phase 01
   guarantees are all present.
4. Path conventions, in `paths.ts`, all relative to the working directory:
   `DEFAULT_SPEC_PATH = 'assets/haruspex-assets.json'`,
   `DEFAULT_ANCHOR_IMAGE = 'assets/haruspex-anchor.png'`,
   `DEFAULT_ANCHOR_RECIPE = 'assets/haruspex-anchor.json'`, and
   `defaultOutPath(kind, id) = `assets/generated/${kind}/${id}.png``. The last
   one is what phase 07 assigns output paths from, so there is exactly one place
   the convention is written down.
5. `kind` drives the pipeline branch: `sprite` and `icon` are chroma-keyed and
   cropped; `texture` is generated seamless and never cropped. The branch is
   phase 09's, but the vocabulary is fixed here so nothing later invents a
   fourth kind quietly.
6. `parseAssetSpec` is tolerant in the way the job configs already are: a
   malformed file yields errors rather than throwing, unknown top-level keys are
   preserved on write so a user's own annotations survive a round trip, and a
   missing optional field takes its default.
7. `renderAssetSpec` writes keys in a fixed order with two-space indentation, so
   a job rewriting the spec produces a minimal diff rather than a reordered file.
8. `validateAssetSpec` reports, with the entry id in every message: duplicate
   ids; an id failing the shape rule; an empty prompt; an `out` path that
   escapes the working directory or is absolute; two entries writing the same
   `out`; a `size` that is not a positive power of two; a `texture` entry with
   `seamless: false`, which is a contradiction.
9. Round-trip property: `parse(render(spec))` deep-equals `spec` for every
   fixture, including one carrying unknown keys.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Parse: a minimal valid spec; a spec with every optional field; malformed JSON
  returns errors and does not throw; a missing `entries` array returns a named
  error.
- Round-trip: `parse(render(x))` equals `x` across fixtures; unknown top-level
  keys survive; key order in the output is stable across two renders.
- Validate: each of the eight rules in step 8 has a test asserting the message
  names the offending entry id. The `out`-escape case is the security-relevant
  one and gets `../`, an absolute path, and a Windows-style path.
- A spec carrying `style.model` and two `style.loras` round-trips with both
  intact, since they are the only inputs their consumers have.
- A fixture spec resembling the dark_times asset set (a few sprites, a texture,
  an icon) parses and validates clean — the realistic shape, not just minimal
  ones.

## Commit

```
feat(assets): add the asset spec schema, parser, writer and validation
```

## Rollback

Delete `src/lib/assets/spec/`. Nothing imports it until phase 06, so removal is
total. A spec file already written into a user project is inert data and can be
left alone.
