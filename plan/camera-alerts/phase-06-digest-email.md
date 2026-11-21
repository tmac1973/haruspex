# Phase 06 — Unusual events in the digest, emailed

**Depends on:** 02, 03, 04, 05 · **Enables:** the full feature: Urgent now, Unusual
in the scheduled digest email

## Goal

The Camera digest job gives the model each entry's level and reason, leads
with Unusual and Urgent events that haven't been dismissed, and can email its
result to the Settings → Cameras → Alerts addresses. That's where Unusual
events reach the user, as the overview decided.

## Files touched

- `src/lib/camera/log.ts`: `renderCameraLogEntry` already shows level and
  reason (Phase 03). Add "(dismissed)" for dismissed entries.
- `src/lib/agent/jobs/types/camera-digest/config.ts`: `email_result: boolean`,
  default false.
- `src/lib/agent/jobs/types/camera-digest/pipeline.ts`: the prompt leads with
  flagged entries; the result gains `flagged: Highlight[]`; email after
  summarising.
- `src/lib/agent/jobs/types/camera-digest/pipeline.test.ts`.
- `src/lib/agent/jobs/types/camera-digest/Editor.svelte`: an **Email the
  result** switch, disabled with a tooltip naming Settings → Cameras → Alerts
  when no addresses are set.
- `src/lib/camera/alertDispatch.ts`: export `sendDigest(result, cameras, eventIds)`.
- `docs/guide/job-types.md` (Camera digest line), and `docs/guide/camera-alerts.md`.

## Steps

1. **Gather**:
   - Unchanged, except entries with `alert_level` of `unusual` or `urgent` that
     haven't been dismissed are listed first, under "Flagged:".
   - Per camera, up to 50 flagged entries are taken first. Other entries fill
     the rest of `PER_CAMERA` (200), so the cap still holds, and flagged
     entries are never pushed out by ordinary ones.
2. **Summarise**:
   - The system prompt adds: "Start with the flagged entries: say what
     happened and why it was flagged. Then summarise the rest."
   - The JSON result gains `flagged: [{time, camera, text}]`.
   - `CameraDigestResult` gains `flagged`, and the step output lists flagged
     entries first.
3. **Email**: when `config.email_result` is on and Gather found at least one
   entry, call `sendDigest`. That sends a `digest` kind through
   `camera_alert_send`:
   - The body lines are the summary, then flagged and highlight lines.
   - It attaches the thumbnails of the first 6 flagged entries.
   - The recipient is from settings, as in Phase 04.

   `sendDigest` follows Phase 04's rules: nothing is sent with alerts off, no
   valid address, or an account that can't send. The step output names the
   cause:
   - "Email not sent: alerts are off (Settings → Cameras → Alerts)"
   - "Email not sent: no address to send to (Settings → Cameras → Alerts)"
   - "Email not sent: the account can't send (Settings → Email)"
     A send failure leaves the run succeeded and puts "Email not sent: <error>"
     in the step output. "Nothing was logged." sends nothing.

4. Editor switch and guide lines.

## Build gate

- `npm run check && npm run lint && npm run test -- camera-digest camera`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- Unit:
  - Flagged entries come first in the prompt.
  - Dismissed entries aren't flagged.
  - `email_result` off sends nothing; on sends one `digest` with flagged
    thumbnails.
  - A send error is in the step output and the run still succeeds.
  - An empty period sends nothing.
- Driven: a daily digest job with Email the result, after a day with one
  Unusual (two people) and one dismissed Urgent. The email leads with the
  Unusual one and shows the dismissed one as an ordinary entry.

## Commit

`feat(camera): flagged events lead the camera digest, which can email itself`

## Rollback

Revert the commit. Saved jobs keep an `email_result` key, which the old config
parser drops.
