# Phase 18 — Settings → Image is a form, not a sentence

**Depends on:** 02 (the ComfyUI backend, whose probe already fetches the list
this phase surfaces) · 03 (the settings UI this replaces) · **Enables:**
nothing — this is a usability debt paid down before anyone else sees it.

## Why this phase exists

The section built in phase 03 puts a trailing prose fragment after every
control, so the panel reads as a sentence with input boxes embedded in it:

```svelte
<label class="row">
  <input type="text" placeholder="http://localhost:8188" ... />
  <span>server address</span>
</label>
<label class="row">
  <input type="password" ... />
  <span>API key, if the server needs one</span>
</label>
```

Three problems, in order of severity:

1. **The checkpoint is free text.** The user types
   `sd_xl_base_1.0.safetensors` from memory, and a typo is not caught until
   Probe is pressed — or worse, until a generation fails. The server knows its
   own checkpoints and Haruspex already asks it.
2. **The reading order is wrong.** A label belongs before its control, so the
   user knows what they are about to type into. Trailing fragments mean reading
   the field, then the explanation, then re-reading the field.
3. **It does not match the house rule.** `CLAUDE.md`: one short sentence per
   section, extra detail in a `title` tooltip. The checkpoint field already
   does this correctly with `<Tooltip>`; the rest of the section does not.

### The list is already being fetched and thrown away

`src/lib/image/comfyui/backend.ts::probeCheckpoint` calls
`GET /object_info/CheckpointLoaderSimple`, extracts
`info.CheckpointLoaderSimple.input.required.ckpt_name[0]` — the complete list
of checkpoints the server has — tests the configured name for membership, and
discards it:

```ts
const names = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
if (Array.isArray(names) && names.length > 0 && !names.includes(name)) {
    return `The backend does not have a checkpoint called "${name}".`;
}
```

So the dropdown is mostly a matter of returning data already on the wire, not
new plumbing. That is what makes this phase small.

## Goal

Settings → Image reads as a form: labelled fields in a sensible order, a URL
you probe, and a checkpoint you pick from what the server reported.

## Files touched

- `src/lib/components/settings/ImageSection.svelte` — the markup and the probe
  handler.
- `src/lib/image/comfyui/backend.ts` — `probe` returns the checkpoint list it
  already retrieves.
- `src/lib/image/types.ts` — the probe result gains an optional list of
  checkpoints. Optional because `none` and the bundled engine have none to
  report, and the type should not pretend otherwise.
- Tests for each.

## Steps

### 1. Probe returns what it found

Widen the probe result with an optional `checkpoints: string[]`. Populate it in
the ComfyUI backend from the call `probeCheckpoint` already makes, rather than
adding a second request.

Keep the existing behaviour when `object_info` cannot be reached. The comment
there is right — a server that will not answer it still answers
`system_stats`, and the check is a convenience rather than a gate. An empty or
absent list must degrade to today's free-text field, not to a dropdown with
nothing in it.

### 2. URL first, then probe, then checkpoint

Reorder the Connection section so it follows the sequence the user actually
performs:

| Field | Control | Note |
| --- | --- | --- |
| Server address | text | `http://localhost:8188` |
| API key | password | optional; say so in the label, not after the box |
| — | **Probe** button | populates the next field |
| Checkpoint | select | from the probe; free text until one runs |

Labels go before their controls. The trailing `<span>` fragments go away; where
one carried real information it becomes a `<Tooltip>`, following what the
checkpoint field already does.

The API key is genuinely optional — a local ComfyUI needs none — so it should
read as optional rather than as a field the user has failed to fill in.

### 3. The checkpoint is a dropdown once the server has been asked

Before a successful probe, or when the server did not report a list, the field
stays free text so a user who knows their filename is never blocked. After a
successful probe it is a `select` over the reported names, with the persisted
value preselected when it is still present.

A persisted checkpoint that the server no longer has must not silently vanish
into an empty select — show it, marked as missing, so the user can see why
generation would fail. This is the same principle as phase 10's report: say
what could not be done rather than presenting a blank.

### 4. Leave the bundled-engine section alone

The local engine's model list is already a proper list with Download, Use and
Delete buttons, licence text and a commercial-use warning — it is the part of
this panel that works. This phase does not touch it beyond the shared label
convention, and should resist the temptation to unify the two, since one picks
from a curated catalogue on disk and the other from whatever a remote server
happens to have.

## Build gate

```
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # the probe result crosses IPC
```

## Test plan

- A probe against a server reporting three checkpoints returns all three.
- A probe against a server that 404s `object_info` still reports `ok`, with no
  checkpoint list — the convenience-not-a-gate contract, asserted rather than
  assumed.
- The field renders as free text before a probe and as a select after one.
- A persisted checkpoint absent from the probed list is still shown, and
  marked.
- Selecting a checkpoint persists it, and the persisted value is preselected on
  reload.
- Every control has a label associated with it, asserted by querying the form
  by accessible name rather than by CSS class — the test should fail if the
  markup regresses to trailing fragments.
- Beware the vacuous case, per TODO lesson (12): a test that only exercises a
  fixture where every field is populated will pass against markup that ignores
  half of them.

## Commit

```
fix(settings): make Settings → Image a form, and pick checkpoints from a list
```

## Rollback

Self-contained in the settings component and the probe result. The widened
probe type is additive and optional, so reverting the UI alone leaves the
backend change harmless. No stored setting changes shape, so a rollback does
not strand anyone's configuration.
