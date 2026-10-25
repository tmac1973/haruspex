# Phase 03 — Background rendering with melt

**Depends on:** 01 (binary resolver, preset setting, folder rules), 02 (the
project the render reads) · **Enables:** 04 (loudness check on the render), 07
(thumbnail from the render), 08 (upload of the render; background-task card and
follow-up turn reused for uploads)

## Goal

The model starts a render of the project and gets control back at once. A card
in the conversation shows percent, time left and Cancel. When the render ends,
the conversation gets a follow-up turn with the result and an automatic check:
duration, streams and measured loudness. Renders use YouTube-friendly H.264/AAC
settings for the project's profile. libx264 is the default, and a hardware
encoder is offered in Settings → Video when a test encode succeeds. This phase
also proves the Phase 02 projects render in stock Kdenlive on macOS and
Windows.

## Files touched

- `src-tauri/src/video/encode.rs` — new: YouTube encoding settings per
  profile, the encoder list, and the test encode.
- `src-tauri/src/video/tasks.rs` — new: `VideoTasks`, the app-state registry of
  background video tasks (render now, upload in Phase 08). Covers spawning,
  progress parsing, cancel, kill on quit, and the orphan record.
- `src-tauri/src/video/check.rs` — new: post-render check (ffprobe and the
  ffmpeg `ebur128` measurement).
- `src-tauri/src/video/commands.rs` — add `video_render_start`,
  `video_task_status`, `video_task_cancel`, `video_encoders_test`.
- `src-tauri/src/lib.rs` — manage `VideoTasks` state, register commands, and
  stop tasks in the existing exit handler.
- `src-tauri/src/orphans.rs` — add a `video-task` record kind so a crashed
  render's melt is swept on next launch.
- `src/lib/ipc/gen/*` — regenerated (`VideoTask`, `VideoTaskState`,
  `RenderCheck`, `EncoderOption`).
- `src/lib/stores/settings.ts` — `videoEncoder` (`'libx264'` default, or one of
  `'h264_vaapi' | 'h264_nvenc' | 'h264_videotoolbox' | 'h264_amf' |
  'h264_qsv'`).
- `src/lib/video/tasks.svelte.ts` — new: frontend task store fed by the
  `video-task-progress` event.
- `src/lib/video/taskWatch.ts` — new: queues a follow-up turn in the owning
  Chat conversation or Code session when a task ends.
- `src/lib/video/taskWatch.test.ts` — new.
- `src/lib/stores/chat.svelte.ts` — when a conversation goes idle, take its
  finished video tasks from `taskWatch` and run one follow-up turn. This copies
  how the Code tab consumes `backgroundWatch`.
- `src/lib/shell/backgroundWatch.ts` — extend `CodeBgWatch` with a `kind:
  'command' | 'video'` field so Code sessions get the same follow-up through
  the existing path. Existing watches default to `'command'`.
- `src/lib/sandbox/protocol.ts` — add `{ kind: 'videoTask'; taskId: string;
  label: string }` to `Artifact`.
- `src/lib/components/video/VideoTaskCard.svelte` — new: progress bar,
  percent, time left, Cancel. When done, it shows Open (system player) and Show
  in folder.
- `src/lib/components/SearchStep.svelte` — render `videoTask` artifacts with
  `VideoTaskCard`.
- `src/lib/components/settings/VideoSection.svelte` — encoder select, filled by
  `video_encoders_test`.
- `src-tauri/src/video/mod.rs` — declare `encode`, `tasks`, `check`.
- `src/lib/agent/tools/video.ts` — add `video_render`, `video_render_status`,
  `video_render_cancel`.
- `src/lib/agent/tools/video.test.ts` — extend.
- `docs/guide/video.md` — add "Render the video" and the encoder setting.

## Steps

1. **Encoding settings (`encode.rs`).**
   - Output is MP4 with `movflags=+faststart`. Video is H.264 High, yuv420p,
     a closed GOP of half the frame rate (`g`), and `bf=2`. Audio is AAC-LC
     at 384 kb/s, 48 kHz stereo.
   - Rate control for libx264 is `crf=18 preset=medium`, with `maxrate` and
     `bufsize` (2× maxrate) by profile height and frame rate. The maxrate
     values follow YouTube's recommended upload bitrates:

     | Profile | maxrate |
     |---|---|
     | 1080p ≤30 | 8M |
     | 1080p 60 | 12M |
     | 1440p ≤30 | 16M |
     | 1440p 60 | 24M |
     | 2160p ≤30 | 45M |
     | 2160p 60 | 68M |

   - Hardware encoders use the same maxrate with constant quality: `qp=20`
     (VAAPI, QSV, AMF), `cq=20` (NVENC), `q:v=65` (VideoToolbox).
   - VAAPI adds `vaapi_device=/dev/dri/renderD128`. Copy the property names
     from Kdenlive's own render presets for the same encoders, so a project
     rendered from Kdenlive with its equivalent preset gives the same result.
2. **Encoder test (`video_encoders_test`).**
   - Encoders tried per OS: Linux `h264_vaapi`, `h264_nvenc`, `h264_qsv`;
     macOS `h264_videotoolbox`; Windows `h264_nvenc`, `h264_amf`, `h264_qsv`.
   - For each, render 2 s of `color:black` with melt to a temp file, 10 s
     timeout, and keep the ones that exit 0 with a non-empty file.
   - libx264 is always listed. Cache the result per melt path and version in
     the app cache folder.
   - Settings → Video runs it when the section opens with no cache, and has a
     Retest button.
3. **Task registry (`tasks.rs`).**
   - `VideoTasks` holds `HashMap<TaskId, TaskEntry>`, each with a `kind`.
     This phase has `render`, one at a time. A second `video_render_start` returns `Err("A render is already
     running (id …). Wait for it or cancel it.")`.
   - The output is `<episode>/renders/<project stem>-<local yyyymmdd-HHMM>.mp4`,
     resolved with `resolve_episode`. The render writes `<that>.part.mp4` and
     renames it on success.
   - Spawn `melt -progress <project> -consumer avformat:<part> <encoder
     props> real_time=-<cores-1>` in its own process group (reuse the
     `process_util.rs` helpers, with a Windows Job object as in
     `code_tools/job.rs`).
   - Parse `percentage:` from stderr, throttle to 2 events per second, and
     emit `video-task-progress { id, state, percent, eta_secs }`. The ETA comes
     from elapsed time and percent.
   - States: `running`, `done { path, check }`, `failed { message, log_tail }`,
     `cancelled`.
   - Cancel kills the group, waits up to 5 s, then hard-kills, and removes the
     part file. Every task is killed on app exit.
   - Each task is recorded in `orphans.rs` while running and removed when it
     ends.
   - Keep the last 40 lines of melt's stderr for errors.
4. **Post-render check (`check.rs`).**
   - ffprobe the output: duration, video stream size/fps/codec, audio stream
     present.
   - Compare the duration with the project length from Phase 02's summary:
     mismatch when off by more than 0.5 s.
   - Run `ffmpeg -nostats -i out.mp4 -map 0:a:0 -af ebur128=peak=true -f null
     -` and parse the summary for integrated loudness (LUFS), loudness range
     and true peak.
   - Return `RenderCheck { duration_secs, expected_secs, size_bytes, video,
     audio, lufs, lra, true_peak_db, problems: Vec<String> }`. Report a
     problem for a length mismatch, missing audio, true peak above -1 dBTP, or
     loudness outside -15…-13 LUFS ("not normalised" until Phase 04).
5. **Follow-up turn (`taskWatch.ts`).**
   - Each task records its owner (`conversationId` or `codeSessionId`) when it
     starts.
   - When the task ends, `taskWatch` stores a notice. The notice uses the same
     format `backgroundWatch` uses for its notifications, so
     `isWatchNotification` keeps it out of title generation and memory.
     Example: "Video render finished: ep012/renders/ep012-20261025-1410.mp4,
     12:03, 412 MB, -14.2 LUFS. No problems."
   - Chat: `chat.svelte.ts` runs one follow-up turn per idle conversation
     with all pending notices, and skips it when the conversation was
     deleted.
   - Code: the existing code-watch path delivers it, with `kind: 'video'`.
6. **Card (`VideoTaskCard.svelte`).** It subscribes to the task store by id and
   shows the label ("Rendering ep012"), a progress bar, percent, time left and
   Cancel. When the task ends, it shows the result line, plus Open and Show in
   folder through the existing open/reveal commands. The card is rebuilt from
   `video_task_status` after an app reload, and shows "Ended when the app
   closed" for unknown ids.
7. **Tools.**
   - `video_render { episode, project? }` (project chosen by Phase 02's
     `default_project`) renders at the project's profile, which came from
     Settings → Video's preset when the project was created. It starts the task and returns
     immediately with the task id. Its result: "Rendering started. You will get
     a message when it finishes; don't poll." It attaches the `videoTask`
     artifact.
   - `video_render_status { id }` gives the state and percent.
   - `video_render_cancel { id }` cancels after `ctx.askUser` confirms, when
     interactive.
8. **Cross-platform check.** Run the Phase 02 ignored test
   `kdenlive_accepts`, plus a melt render of each golden, on mactest and
   wintest with stock Kdenlive installed. This confirms Phase 02's forward-slash path rule on
   Windows and its `.app` paths on macOS. A failure here blocks the phase
   and is fixed in Phase 02's writer as a bug, with a regression test.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff.
- `cargo test -- --ignored kdenlive_accepts` passes on Linux, mactest and
  wintest.
- `npm run test` and `cargo test` also pass on mactest and wintest
  (`ssh haruspex-mac`, `ssh haruspex-win`).

## Test plan

- Rust:
  - Progress parsing from recorded melt stderr.
  - ETA maths.
  - Encoder property sets per encoder and profile (golden).
  - Output naming and `.part` rename.
  - The second-render refusal.
  - Cancel removes the part file. Use a fake `melt` script that sleeps and
    prints percentages.
  - `ebur128` summary parsing from recorded output.
  - `RenderCheck` problem rules.
- Vitest:
  - `taskWatch` queues one follow-up per idle conversation, merges two
    notices, and drops notices for deleted conversations.
  - The Code path receives `kind: 'video'`.
  - `VideoTaskCard` states.
  - Tool results and the cancel confirm.
- Manual, Linux:
  - Render the ep010 project. Chat stays usable during the render, the card
    advances, and the follow-up turn reports the file and loudness. The file
    plays and its length matches.
  - Cancel mid-render: melt is gone within 5 s and no part file is left.
  - Quit the app mid-render: melt is gone.
  - Kill the app with SIGKILL mid-render, relaunch: the orphan is swept.
  - Pick VAAPI in Settings → Video and render again: it is faster and the
    output plays.
- Manual, mactest and wintest:
  - The same render works.
  - Only the VideoToolbox / NVENC / AMF options that work appear.
  - Open and Show in folder work.
  - Open each Phase 02 golden in Kdenlive's window: no warning dialog
    appears.
- Integration (ignored, needs ffmpeg/melt), A/V sync: a test clip at
  30000/1001 fps and one at 25 fps, each with a white flash and a 1 kHz beep
  every 10 s, made with ffmpeg's `lavfi` sources. Cut them together and render
  at 1080p60. At every flash in the output, the beep starts within one frame.

## Commit

`feat(video): render projects in the background with progress and a follow-up`

## Rollback

Revert the commit. The `kind` field on `CodeBgWatch` defaults to `'command'`,
so reverting it doesn't affect existing watches. Partial renders are `.part.mp4`
files and can be deleted. The orphan record kind is ignored by older builds.
