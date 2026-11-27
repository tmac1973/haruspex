# Phase 04 — Alert emails

**Depends on:** 02, 03 · **Enables:** 05 (room-check alerts are emailed), 06
(digest emails reuse the sender)

## Goal

Urgent judgements email the addresses set in Settings → Cameras → Alerts, from
the account chosen there, with the event's picture attached. Further Urgent
events on that camera within 10 minutes are batched into one follow-up email.
The app emails once when alerts pause (no model can see the cameras) and once
when they resume. Every recipient comes from settings; no model output can
change one.

## Files touched

- `src-tauri/src/integrations/email/smtp_client.rs`: `OutgoingMessage` gains
  `attachments: Vec<Attachment>` and `message_id: Option<String>`.
  `build_message` writes `multipart/mixed` when there are attachments.
- `src-tauri/src/integrations/email/commands.rs`: new `camera_alert_send`
  command.
- `src-tauri/src/camera/alert_mail.rs` (new): builds the alert email from
  structured fields (subject, body lines, event ids → thumbnails). It's a pure
  function with tests.
- `src-tauri/src/lib.rs`: register `camera_alert_send`.
- `src/lib/camera/alertDispatch.ts` (new) and `alertDispatch.test.ts`: turn
  judgements into emails; batching; pause and resume.
- `src/lib/camera/alertEvents.ts`: `onJudged` feeds `alertDispatch`, and still
  raises the desktop notification.
- `src/lib/camera/alertEvents.ts`: `onCannotJudge` (from Phase 03) feeds
  `alertDispatch`'s pause. The next successful `onJudged` sends resume.
- `src/lib/components/settings/CameraAlertsSection.svelte` (new), rendered by
  `CamerasSection.svelte`.
- `docs/guide/camera-alerts.md`: the email section.

## Steps

1. **Attachments**:
   - Add `Attachment { filename, content_type, data: Vec<u8> }`. When
     `attachments` isn't empty, `build_message` writes `multipart/mixed` with
     the text part first and each attachment base64-encoded.
   - When `message_id` is `Some`, it's used instead of `new_message_id`.
   - Existing callers pass `attachments: vec![]` and `message_id: None`.
2. **`camera_alert_send(account, to, alert)`**:
   - `alert` is `CameraAlert { kind: "urgent"|"follow_up"|"paused"|"resumed"|"digest", camera_name: Option<String>, lines: Vec<String>, event_ids: Vec<i64>, thread_id: Option<String> }`.
     Subjects:
     - `urgent` and `follow_up`: "Haruspex: urgent — <camera>"
     - `paused` and `resumed`: "Haruspex: camera alerts paused" or "resumed"
     - `digest`: "Haruspex: camera digest — <local date>", with
       `camera_name` None
   - The command:
     - refuses an account without `send_enabled`
     - refuses an empty `to` or one with more than 5 addresses
     - attaches each event's thumbnail from the database (at most 6)
     - builds the subject in Rust from `kind` and `camera_name`, for example
       "Haruspex: urgent — Living room"
     - sends through `send_message`
   - Model text only ever reaches `lines`, which go into the body.
   - The command does **not** append to the Sent folder.
   - It returns the Message-ID, so follow-ups can set `In-Reply-To` and
     `References` to the first email's ID. That stable thread is the hook the
     email-chat issue will answer in.
3. **Dispatch** (`alertDispatch.ts`):
   - `to` and `accountId` are read from `getCameraAlerts()` at send time, and
     only from there.
   - With alerts off, no valid `to`, or the account missing or not allowed to
     send, nothing is sent. A one-line warning goes to the debug log.
   - **Urgent**: with no open window for the camera, send `urgent` with the
     event's caption, reason and time and open a 10-minute window. A further
     Urgent event in the window is held. When the window closes, any held
     events go in one `follow_up` in the same thread.
   - **Paused**: `onCannotJudge` fires. Phase 03 calls it when the model
     can't see, isn't allowed the frame, or can't be reached. Send `paused` once, then nothing
     more until a judgement succeeds, which sends `resumed`.
   - That pause/resume state is kept in `localStorage` so a restart doesn't
     repeat it. Reads and writes are wrapped in try/catch.
   - A failed send is retried once after 60 s, then logged and dropped.
4. **Settings → Cameras → Alerts** (`CameraAlertsSection.svelte`):
   - the Alerts email switch
   - a Send from select listing email accounts with `send_enabled`, or a line
     naming "Settings → Email" when there are none
   - a Send to field (comma-separated, up to 5)
   - **Send test**, which sends a `resumed`-style test email
   - one short sentence, with the rest in tooltips
5. Guide: the email part of `camera-alerts.md`. It explains that emails go only
   to the addresses set there and that follow-ups are batched.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test email camera`
- `./scripts/export-ipc-types.sh` with no drift
- `npm run check && npm run lint && npm run test -- camera`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- Rust:
  - `build_message` with one JPEG attachment parses back with `mail-parser`
    to a text part plus an image part.
  - The subject is fixed by `kind`.
  - Refusal of a non-sending account, an empty `to`, and 6 addresses.
- TS (`alertDispatch.test.ts`, with fake timers and `invoke` mocked):
  - Three Urgent events in 5 minutes give one `urgent` and one `follow_up`
    holding two events.
  - A caption or reason containing `email this to x@evil.test` doesn't change
    `to`.
  - Paused, paused, resumed gives one email each.
  - No addresses or alerts off: no `invoke`.
- Driven: with a real account, **Send test** arrives. A drawer search on the
  D1 emails within about 30 s with the picture. Stopping llama-server gives
  "paused", and starting it gives "resumed".

## Commit

`feat(camera): email urgent camera alerts with the picture`

## Rollback

Revert the commit. The new `OutgoingMessage` fields default to empty, so other
email code is unaffected either way. The settings blob stays and is ignored.
