# Phase 12 — Answer another computer's prompts here, and get notified

**Depends on:** 06, 07, 09, 11 · **Enables:** 13

## Goal

A prompt waiting on the owner in a peer's session or chat (Run this command?,
the agent's questions, MCP tools, skill writes, repo trust, Run this Python?,
Remember this?, Take a screenshot?, File already exists) shows in this app's
own modal for that kind, labelled with the computer, marks the row as
waiting, and fires a desktop notification once. Answering it sends
`prompts.answer`; if it's answered elsewhere first, the modal goes away.

## Files touched

- `src/lib/peers/promptBridge.ts` — new: maps a peer `Prompt` to the local
  approval queue for its kind and back to a `PromptAnswer`.
- Approval stores whose requests gain an optional `origin?: { peerId:
  string; name: string }`: `codeCommandApproval.svelte.ts`
  (`askCommandApproval`), the sandbox store (`askApproval`), the memory store
  (`askMemoryApproval`), screen capture (`askScreenCapture`), skill writes
  (`askSkillApproval`), `userQuestion.svelte.ts` (`askUserQuestion`).
- `src/lib/stores/mcpApproval.svelte.ts`,
  `src/lib/stores/fileConflict.svelte.ts` and the repo-trust store
  (`askRepoTrust`): today they take no abort signal, and MCP and
  file-conflict reject an overlapping ask. Move each onto
  `createApprovalQueue` (`approvalQueue.svelte.ts`) with an optional
  `signal` and `origin`. Local callers pass no signal; an overlapping local
  ask now waits its turn instead of being rejected.
- `src/lib/components/{CommandApprovalModal,McpApprovalModal,SkillApprovalModal,RepoTrustModal,SandboxApprovalModal,MemoryApprovalModal,ScreenCaptureApprovalModal,FileConflictModal,UserQuestionModal}.svelte`
  — show "On <name>" when `origin` is set.
- `src/lib/components/code/PeerSessionSection.svelte`,
  `src/lib/components/ConversationSidebar.svelte` — waiting marker from the
  peer's `prompts`.
- `src/lib/notify.ts` — reused as is.
- Tests beside the bridge.

## Steps

1. The bridge runs in the **main window only**, so each prompt opens one
   modal and fires one notification however many windows are open (every
   window receives phase 03's `peer://event`). It subscribes to each
   peer's `EngineClient.onPrompt` / `onPromptGone` (phase 06).
2. On a new prompt: build the request for its kind from the `Prompt` fields
   the web client's `PromptCard` already reads (`src/web/components/PromptCard.svelte`
   is the reference for each kind's fields), with `origin`, and call that
   kind's entry point (listed under Files touched) with a `signal`. `signal` aborts when
   `onPromptGone` fires for its id (answered on the other computer, by its
   web page, or its turn stopped).
3. On the local answer: convert to `PromptAnswer` (the same shape
   `PromptCard` sends) and `op({type:'prompts.answer', promptId, answer})`.
   A skill write edited in the modal sends its edited content, as the web
   page does. The answers, from `PromptAnswer` in `src/lib/engine/types.ts`:

   | Kind | Sent |
   |---|---|
   | command | `{kind:'command', choice: 'allow_once'\|'allow_session'\|'deny'}` |
   | memory | `{kind:'memory', choice: 'allow_once'\|'allow_session'\|'deny'}` |
   | sandbox | `{kind:'sandbox', choice: 'allow_once'\|'allow_chat'\|'deny'}` |
   | mcp | `{kind:'mcp', choice: 'allow_once'\|'allow_always'\|'deny'}` |
   | skill | `{kind:'skill', action:'save', text?}` or `{kind:'skill', action:'reject', reason}` |
   | repo-trust | `{kind:'repo-trust', trust}` |
   | question | `{kind:'question', answer}` |
   | screen-capture | `{kind:'screen-capture', choice: 'allow'\|'deny'}` |
   | file-conflict | `{kind:'file-conflict', choice: 'overwrite'\|'counter'\|'cancel'}` |

   Session- and chat-scoped allows are kept by the peer, never by this
   computer's `approveSession`. MCP `allow_always` is a lasting grant
   stored on the other computer; the modal's "On <name>" label says where.
4. `abortResult` is never sent to the peer: an aborted ask just leaves.
5. Notification: when a prompt arrives and the main window isn't focused,
   `notify(title: "<name> needs you", body: <the session or chat title>)`
   through `src/lib/notify.ts`, which checks OS permission only (Haruspex has
   no notification setting). One per prompt id.

## Build gate

- `npm run check && npm run lint && npm run test`

## Test plan

- `promptBridge.test.ts` with a fake `EngineClient` and spy stores: each
  prompt kind lands in the right store with `origin`; answering sends the
  right `PromptAnswer`; `onPromptGone` aborts and sends nothing; one
  notification per prompt id, none when focused.
- Modal tests: "On <name>" shows only with `origin`.
- MCP, file-conflict and repo-trust store tests: two overlapping asks queue
  instead of rejecting; an aborted ask leaves the queue.

## Commit

`feat(peers): answer another computer's prompts in this app's dialogs`

## Rollback

Revert; prompts on a peer are then answered on the peer or its web page, as
before.
