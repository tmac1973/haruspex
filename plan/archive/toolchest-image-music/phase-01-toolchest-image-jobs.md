# Phase 01 — Toolchest: async image jobs, job phases, `meta.api`

**Depends on:** nothing · **Enables:** Phase 02 (image jobs and their
detection), and Phase 05 (music `phase` and `meta.api`)

> This phase is done in **/home/tim/Projects/llama-toolchest**, not in Haruspex.
> Every path below is relative to that repo.

## Goal
Give toolchest an async image job API like the music one, so a client can see
where a render is and stop waiting on it. Both job types get a `phase` field.
Generation entries in `/v1/models` get a `meta.api` list, so a client can tell
which routes this build has without trying them. Once this is deployed to
compute2:3000 and asmodean:3000, Haruspex has the API it targets.

## Files touched
- **`internal/api/gen_jobs.go`** (new): the job store, generic over its payload,
  moved out of `gen_music.go`.
  - Moves: `add`, `view`, `update`, `prune`, the watcher, `newJobID`, and the
    24 h / 200-record retention.
  - Prune deletes each job's output files.
- **`internal/api/gen_music.go`:**
  - use the shared store;
  - add the `Phase` field and set it as the job advances.
- **`internal/api/gen_image_jobs.go`** (new): image job types and handlers:
  create, get, image, delete.
- **`internal/api/gen_images.go`:**
  - pull the forward-to-sd-server code into `forwardImage(ctx, inst, body)`, so
    the synchronous route and image jobs share it;
  - `pickInstance` is unchanged.
- **`internal/api/server.go`:**
  - register the four `/v1/images/jobs` routes under `apiKeyAuth`, next to the
    music routes (~L793-806);
  - start one prune watcher for both stores.
- **`internal/api/v1models.go`:** add `meta.api` to image and music entries
  (L73-115).
- **`internal/api/gen_image_jobs_test.go`** (new), **`gen_music_test.go`**,
  **`gen_images_test.go`**: tests.
- **`web/templates/help.html`** (~L440-477): document image jobs, `phase` and
  `meta.api`.
- **`plan/generation-backends/verification.md`:** add a dated note on the
  Haruspex client.

## Steps
1. **Extract the job store.** Create `gen_jobs.go` with
   `type jobStore[T any] struct`, which keeps the existing mutex, map and
   ordering, plus `add`, `view`, `update` and `prune(now, files func(T) []string)`.
   - Constants: `jobKeep = 24 * time.Hour`, `jobMax = 200`, prune every
     10 min.
   - Point music at `jobStore[musicJob]`.
   - Music behaviour does not change: existing `gen_music_test.go` passes
     unchanged before step 2.
2. **Phases.** Add `Phase string \`json:"phase"\`` to `musicJob`.
   - Values: `queued` (on submit), `composing` (before `/lm`), `synthesizing`
     (before `/synth`), `saving` (writing the file).
   - When the job ends (succeeded, failed or cancelled) the phase is `""` and
     is left out of the JSON (`omitempty`).
   - While the ticket waits behind a GPU hold (benchmark or autotune), phase
     stays `queued`. Only `queue_position` tells the client anything there.
3. **Image job request.** `POST /v1/images/jobs`:
   - Body: the same JSON as `/v1/images/generations`, limited to 128 MiB, with
     `model` resolved by `pickInstance`.
   - Multipart is refused: 400 `bad_request`, "image jobs take JSON".
   - Keep the raw body for forwarding. For the echo, keep only `model`,
     `prompt`, `size` and `n`; never echo `init_image` or the
     `<sd_cpp_extra_args>` block, which can be megabytes.
   - Queue with the same per-GPU ticket as the synchronous route.
     `ErrQueueFull` → 429 `queue_full` with `Retry-After: 30`.
   - Reply 202 `{"id","status":"queued"|"running","phase","queue_position"}`.
4. **Image job run.** When the ticket is granted:
   - set `status=running`, `phase=generating`;
   - call `forwardImage` with a background context, so the job outlives the
     HTTP request;
   - parse `data[].b64_json`;
   - set `phase=saving` and write each image to
     `<data_dir>/gen-output/images/<id>-<n>.png`;
   - set `status=succeeded` with `images:[{"url":"/v1/images/jobs/<id>/image/<n>"}]`.
   - A backend error gives `status=failed`, with `error` set to
     `"generating: <message>"`.
5. **Image job object.** `GET /v1/images/jobs/{id}` returns `{id, model,
   status, phase, queue_position, request, images, error, submitted, started,
   finished}`. Unknown id → 404 `job_not_found`.
6. **Image download.** `GET /v1/images/jobs/{id}/image/{n}` serves the PNG
   with `http.ServeFile` and Content-Type `image/png`.
   - Before success → 409 `not_ready`.
   - `n` out of range → 404 `not_found`.
7. **Cancel.** `DELETE /v1/images/jobs/{id}` always returns 204 for a known id.
   - **Queued:** remove the ticket and set `cancelled`.
   - **Running:** set `cancelled` now; sd-server cannot stop, so when the
     forward returns, the result is discarded and the slot is released as
     normal.
   - **Finished:** nothing happens.
   - Record "running jobs cannot be interrupted" in `help.html`.
8. **`meta.api`.** In `v1models.go`, generation entries get:
   - **image:** `["images.sync","images.jobs"]`, plus `"images.edits"` when the
     set has the `edit` capability;
   - **music:** `["music.jobs","music.ace_step"]`.
   - Text entries get no `api`.
9. **Docs.** In `help.html`, add an "Image jobs" block with a curl example
   (create, poll, fetch), describe `phase` for both job types, and describe
   `meta.api`.
10. **Deploy.** Deploy to compute2 and asmodean, then curl-check (see Test
    plan).

## Build gate
```bash
go build ./...
go vet ./...
go test ./internal/...
make js-test
```

## Test plan
Automated, against the fake sd-server and ace-server already used in
`gen_images_test.go` and `gen_music_test.go`:
- **Create then succeed:** 202 with `phase=queued`. The poll goes `running` /
  `generating`, then `succeeded` with one image URL. `/image/0` returns PNG
  bytes; `/image/1` is 404; `/image/0` before success is 409.
- **Echo:** an `init_image` in the body is absent from `request`.
- **Queue full:** the 17th job on a GPU gets 429 with `Retry-After`.
- **Cancel:** cancelling a queued job removes it from the queue (snapshot
  `waiting` drops). Cancelling a running job leaves `cancelled`, the late
  result never appears, and the slot is released.
- **Prune:** prune removes an image job's PNG files after `jobKeep`.
- **Music:** phases go `queued` → `composing` → `synthesizing` → `saving`,
  then empty when done.
- **`/v1/models`:** carries `meta.api` for image and music entries, includes
  `images.edits` only for edit-capable sets, and has no `api` on text entries.

Manual, after deploy:
```bash
curl -s http://asmodean:3000/v1/models | jq '.data[] | {id, api: .meta.api}'
```
- POST an image job with
  `{"model":"qwen-turbo-local","prompt":"a red fox","size":"512x512"}`.
- Poll it, then save `/image/0` and open it.

## Commit
`feat(generation): async image jobs, job phases and meta.api for clients`

## Rollback
Revert the commit. The synchronous image route and the music API keep their
current shapes, so existing clients are unaffected. Haruspex Phase 02 falls
back to the synchronous route when `meta.api` lacks `images.jobs`, so a
toolchest without this phase is still usable.
