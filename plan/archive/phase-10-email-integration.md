# Phase 10: Email Integration (Multi-Provider IMAP)

## Status

**Planning only — no implementation yet.** This document captures the design
thinking for adding optional email integration to Haruspex, starting with
read-only access over IMAP to any mainstream email provider the user already
uses. It's meant to be read, argued with, and edited before any code gets
written.

## Goal

Let Haruspex reach out to the user's email account — read their recent
messages, help them find specific threads, summarize what came in — without
compromising the "runs on your computer, nothing leaks to the cloud" core
value. The integration is opt-in, off by default, multi-provider, and
designed from day one to grow into sending email in Phase 10.2.

The first use case is small and concrete: **"What did I get in my inbox in
the last 4 hours? Summarize it."** Read-only, one-line prompt, done. That
single prompt has to work against Gmail, Fastmail, iCloud, Yahoo, and any
generic IMAP server the user can point us at.

## Prerequisites

- Phase 9 (local filesystem / agent loop / tool dispatch) — reuses the same
  tool-exposure pattern the `fs_*` tools use.
- The remote inference server work — tools are already filtered based on
  backend capability, and email tools will plug into the same gating.
- The `research_url` sub-agent pattern — `email_summarize_message` is a direct
  sibling of it, reusing the same compression-via-sub-agent design.

---

## Resolved Decisions (from planning discussion)

Tim and I already worked through the open questions in conversation. These
are the settled answers — they drive the rest of the doc:

| Decision | Choice | Source |
|---|---|---|
| Protocol | IMAP with credentials, not Gmail API | Google CASA verification is off the table for cost reasons |
| Scope | Multi-provider IMAP, not Gmail-only | "If we're doing IMAP we might as well support all/most IMAP" |
| Naming | "Email" integration, not "Gmail" integration | Follows from multi-provider scope |
| Gmail-specific path | Yes — Gmail gets a provider preset + is the primary test target | Tim's day-to-day inbox |
| Provider coverage (10.1) | Gmail, Fastmail, iCloud, Yahoo, Generic/Custom | Microsoft/Outlook deferred (OAuth-only, no app passwords) |
| 2FA as prerequisite | Accepted — required for all providers that support app passwords | Table stakes in 2026 |
| Tool visibility | Invisible when disabled | "tools that aren't turned on should be invisible yes" |
| Context cost strategy | Sub-agent summarization | "emails should be summarized with a sub agent to save on context" |
| Sending email | Phase 10.2 — design 10.1 with it in mind | "We'll want to prep for email sending almost as soon as we're done with this phase" |
| Multi-account | Supported from day 1 | Natural consequence of multi-provider |
| Credential storage | Settings blob (same as inference API key) | Consistent with existing trust model; keyring deferred |
| MCP architecture | Deferred to Phase 13+ | "For one integration it's not worth the investment" |
| Next-most-likely integrations | Calendar, Drive, Docs (Google-first) | Informs Phase 11+ roadmap |

---

## Deliverables (Phase 10.1 — Read-Only Multi-Provider Email)

User-testable scenarios that must work at the end of 10.1:

- **Scenario 1 — Recent inbox summary**: Enable the Email integration in
  Settings, pick "Gmail" from the provider dropdown, paste an app password,
  ask "summarize my email from the last 4 hours." The model lists recent
  messages, summarizes each via the sub-agent, and produces a digest.
- **Scenario 2 — Sender lookup**: Ask "did I get any emails from Alice this
  week?" The model uses the list tool with a `from` filter and reports
  matches.
- **Scenario 3 — Deep read**: Ask "read the latest email from my landlord
  and tell me what it says." The model fetches the message body (via the
  escape-hatch tool) and summarizes.
- **Scenario 4 — Non-Gmail provider**: Same flow as Scenario 1 but connect
  to a Fastmail account instead. Confirms the provider abstraction works.
- **Scenario 5 — Two accounts**: Configure both a Gmail account and a
  Fastmail account. Ask "summarize recent email from both accounts." Both
  appear in the output with their account labels.

Explicitly NOT in Phase 10.1:

- Sending / replying / drafting (Phase 10.2)
- Attachment download (Phase 10.3)
- Label / folder management beyond "INBOX"
- Threading (Gmail's thread concept doesn't map cleanly to IMAP)
- Full-text body indexing / search
- Calendar, Drive, Docs, any other non-email service
- OAuth authentication (Phase 10.4)
- Outlook / Microsoft 365 (needs OAuth, deferred)

---

## Provider Landscape

The point of going multi-provider is that every major IMAP host has roughly
the same shape. The differences are (a) hostname/port, (b) how the user
generates an app password, and (c) minor capability quirks. We encode these
as provider presets and let the user pick one from a dropdown — or choose
"Custom" and type their own settings for anything we don't pre-fill.

| Provider | IMAP Host | SMTP Host (for 10.2) | App Password? | Supported in 10.1 |
|---|---|---|---|---|
| Gmail | `imap.gmail.com:993` | `smtp.gmail.com:465` | Yes (2FA required) | ✅ Primary test target |
| Fastmail | `imap.fastmail.com:993` | `smtp.fastmail.com:465` | Yes (2FA required) | ✅ |
| iCloud | `imap.mail.me.com:993` | `smtp.mail.me.com:587` | Yes (2FA required) | ✅ |
| Yahoo | `imap.mail.yahoo.com:993` | `smtp.mail.yahoo.com:465` | Yes (2FA required) | ✅ |
| Generic / Custom | user-entered | user-entered | user-provided | ✅ |
| Microsoft 365 / Outlook | — | — | **No** (OAuth only) | ❌ Deferred to Phase 10.4 |

Microsoft deprecated basic auth for Outlook.com / Microsoft 365 in late 2022.
There is no app-password path — every connection must go through OAuth 2.0 with
an Azure-registered application. That's a different auth flow than the other
providers and meaningfully larger scope, so it waits for Phase 10.4 when we
tackle OAuth generally.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Frontend (SvelteKit)                                             │
│  • IntegrationsSettings.svelte — new Settings section            │
│  • EmailAccountForm.svelte — per-account credential entry        │
│  • Provider preset dropdown + "Custom" escape hatch              │
│  • email_* tools in getAgentTools() — visible only when ≥1       │
│    account is enabled                                            │
│  • executeEmail* wrappers in search.ts                           │
└──────────────────────────────────────────────────────────────────┘
                            │ invoke('email_*', {...})
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│ Rust Backend — src-tauri/src/integrations/email/                 │
│  • provider.rs      — provider presets (Gmail/Fastmail/…)        │
│  • auth.rs          — credential types + validation              │
│  • imap_client.rs   — async-imap wrapper + mail-parser           │
│  • smtp_client.rs   — lettre stub (Phase 10.2)                   │
│  • parser.rs        — RFC 5322 → NormalizedMessage               │
│  • sub_agent.rs     — per-message summarization                  │
│  • commands.rs      — Tauri command handlers                     │
│  • mod.rs           — shared types, re-exports                   │
└──────────────────────────────────────────────────────────────────┘
                            │
           ┌────────────────┼────────────────┐
           ▼                ▼                ▼
    imap.gmail.com   imap.fastmail.com   (custom host)
    :993 (TLS)       :993 (TLS)          :port (TLS)
```

### Module layout

```
src-tauri/src/
├── integrations/
│   ├── mod.rs                   # shared types (NormalizedMessage, etc.)
│   └── email/
│       ├── mod.rs               # re-exports, shared email types
│       ├── provider.rs          # EmailProvider enum + presets
│       ├── auth.rs              # credential struct + validation
│       ├── imap_client.rs       # async-imap + TLS plumbing
│       ├── smtp_client.rs       # lettre stub for 10.2
│       ├── parser.rs            # mail-parser → NormalizedMessage
│       ├── sub_agent.rs         # summarize_message sub-agent
│       └── commands.rs          # #[tauri::command] handlers
└── lib.rs                       # registers email_* commands
```

Starting with a nested `integrations/email/` submodule (instead of a flat
`integrations/email.rs`) is a deliberate bet: email is big enough — auth,
IMAP, SMTP, parsing, sub-agent — that a single file will become unwieldy
fast. Splitting it upfront is cheaper than refactoring mid-phase.

### Rust crate choices

- **`async-imap`** — mature pure-Rust IMAP client, async via tokio. Handles
  IDLE, SEARCH, FETCH, SASL. Works with Gmail, Fastmail, iCloud, Yahoo.
- **`mail-parser`** — MIME decoding, header parsing, charset conversion,
  multi-part body extraction. Far better than rolling our own RFC 5322
  handler.
- **`tokio-rustls`** — TLS transport for IMAP/SMTP. Already a dep via
  reqwest's rustls feature.
- **`lettre`** (Phase 10.2) — SMTP client for sending. Pure Rust, supports
  STARTTLS and implicit TLS, plays well with tokio-rustls.
- **No OAuth crate yet** — Phase 10.4. When we get there, we'd reach for
  `oauth2` or direct `reqwest` token exchange plus `async-imap`'s SASL
  XOAUTH2 mechanism.

---

## Credential Model (send-ready from day 1)

The credential struct stores both IMAP and SMTP endpoints from the start,
even though Phase 10.1 only uses the IMAP half. This means Phase 10.2
becomes "implement the send code path" without a settings migration or
re-entering credentials.

```typescript
interface EmailAccount {
    id: string;                       // stable UUID, generated on create
    label: string;                    // user-facing ("Work Gmail", "Personal")
    enabled: boolean;                 // master toggle per account
    sendEnabled: boolean;             // unused in 10.1; gates send in 10.2
    provider: 'gmail' | 'fastmail' | 'icloud' | 'yahoo' | 'custom';
    emailAddress: string;             // "alice@example.com"
    password: string;                 // app password (plaintext in settings blob)

    // IMAP endpoint — filled from provider preset, editable for 'custom'
    imapHost: string;
    imapPort: number;                 // usually 993
    imapTls: 'implicit' | 'starttls'; // all presets use implicit; custom can override

    // SMTP endpoint — stored now, unused until 10.2
    smtpHost: string;
    smtpPort: number;                 // usually 465 or 587
    smtpTls: 'implicit' | 'starttls';
}

interface AppSettings {
    // ...existing fields...
    integrations: {
        email: {
            accounts: EmailAccount[];
        };
    };
}
```

Design notes:

- **Why `accounts` as an array instead of `gmail`/`fastmail`/etc. fields?**
  Because "two Gmail accounts" is a reasonable thing to want (personal +
  work) and hardcoding one slot per provider doesn't scale.
- **Why a `sendEnabled` flag that does nothing in 10.1?** So Phase 10.2
  doesn't have to migrate the settings blob. We can ship 10.2 with the flag
  already respected, defaulting to `false` (user opts into sending
  separately from opting into reading).
- **Why `id` as UUID instead of using `emailAddress` as the key?** So the
  user can rename / delete / re-add an account without the tool call cache
  referencing dead records.
- **Same trust level as existing credentials.** Stored in localStorage /
  settings JSON with the Brave API key and inference API key. Keyring
  integration is a future cross-cutting change that covers all credentials
  at once.

---

## Tool Interface for the Model

Three tools in Phase 10.1. This is a departure from the Phase 10.1-draft
two-tool design (list + read) because Tim explicitly chose the sub-agent
pattern:

```typescript
// 1. Cheap list — returns metadata only, no bodies
email_list_recent({
    account_id?: string,          // optional — if omitted, searches all enabled accounts
    hours?: number,               // "last N hours" window (exclusive with since_date)
    since_date?: string,          // ISO 8601 alternative
    from?: string,                // substring filter on sender name or address
    subject_contains?: string,
    max_results?: number          // default 20, cap 50
})
→ EmailListing[]
  // Each EmailListing has: message_id, account_id, subject, from_name,
  // from_email, date, snippet (~200 chars). No body.

// 2. Sub-agent summary — expensive per-call, model calls this per message
//    it wants to understand. Runs a separate chat completion with a focused
//    prompt to compress the full message body to a short summary.
email_summarize_message({
    account_id: string,
    message_id: string,
    focus?: string                // optional: "what's the sender asking for?"
})
→ { summary: string; from: string; subject: string; date: string; }
  // Full body never enters the main agent's context.

// 3. Escape hatch — read the full message body when the user explicitly
//    asked to see it verbatim, or when the summary isn't enough.
email_read_full({
    account_id: string,
    message_id: string
})
→ NormalizedMessage with body populated
```

The model's natural flow for "summarize my email from the last 4 hours":

1. `email_list_recent({ hours: 4 })` → 12 messages, metadata only
2. `email_summarize_message({ message_id: "<x>" })` × 12 → 12 short summaries
3. Synthesize a digest and reply to the user

Total main-agent context cost: ~12 short summaries (~2-3k tokens) instead of
12 full bodies (~20-60k tokens). The sub-agent absorbs the expensive work
and never pollutes the main agent's context.

### Sub-agent design (mirrors `research_url`)

`email_summarize_message` spawns a separate chat completion with:

- A short, focused system prompt: "You are an email summarizer. Given the
  full body of a single email, produce a 2-4 sentence summary covering who
  sent it, what they want / what it's about, any action items or dates, and
  any critical information. Do not editorialize. Do not refuse to summarize
  marketing or promotional content — just note the category and the key
  offer. Plain text, no markdown."
- A user turn containing the raw email body (stripped of quoted reply
  chains where we can detect them — `mail-parser` helps here).
- A small max-tokens budget (say 300) and zero tools.
- The response is returned as the `summary` field; if the sub-agent fails
  or times out, we fall back to returning the plaintext snippet with a note
  that summarization was unavailable.

This uses exactly the same sub-agent harness as `research_url` (see
`src/lib/agent/research.ts` for the existing reference implementation) —
just a different system prompt and different input.

### When does the model call `email_read_full`?

- The user explicitly asks for it ("read me the full email from Bob")
- The summary left something ambiguous and the model decides it needs the
  raw text to answer accurately
- Debug / inspection use cases

The system prompt guides the model toward preferring `email_summarize_message`
as the default and reaching for `email_read_full` only when necessary.

---

## Provider Presets

```rust
pub struct EmailProviderPreset {
    pub id: &'static str,            // "gmail", "fastmail", ...
    pub label: &'static str,         // "Gmail"
    pub imap_host: &'static str,
    pub imap_port: u16,
    pub imap_tls: TlsMode,
    pub smtp_host: &'static str,
    pub smtp_port: u16,
    pub smtp_tls: TlsMode,
    pub app_password_url: &'static str, // link to the provider's app-password docs
    pub requires_2fa: bool,
}

pub const PRESETS: &[EmailProviderPreset] = &[
    EmailProviderPreset {
        id: "gmail",
        label: "Gmail",
        imap_host: "imap.gmail.com",
        imap_port: 993,
        imap_tls: TlsMode::Implicit,
        smtp_host: "smtp.gmail.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Implicit,
        app_password_url: "https://myaccount.google.com/apppasswords",
        requires_2fa: true,
    },
    // ... Fastmail, iCloud, Yahoo ...
];
```

The frontend reads the preset list via a `email_list_providers` Tauri command
and populates the dropdown. Selecting a preset auto-fills the IMAP/SMTP
fields and shows a "Generate app password" link pointing at the provider's
docs. "Custom" leaves everything blank for manual entry.

---

## System Prompt Guidance

Add a short section to `buildSystemPrompt` — conditional, only emitted when
at least one email account is enabled:

> **Email:** The user has connected one or more email accounts. Only call
> `email_*` tools when the user has explicitly asked about email — do not
> proactively check for new messages. Respect the scope the user asked
> for: "recent email" means the latest few hours unless they specify
> otherwise. Prefer `email_summarize_message` over `email_read_full` — the
> summarizer produces a 2-4 sentence digest of each message, which is
> usually enough to answer the user's question without pulling the full
> body into context. Reach for `email_read_full` only when the user
> explicitly asked to see verbatim content or the summary was insufficient.
> When presenting a digest of multiple messages, group by sender or topic
> if that helps readability, include dates, and never fabricate message
> content you didn't see in a tool result.

---

## Implementation Plan (rough, not a commitment to task order)

### 10.1a — Rust foundation

- [ ] Create `src-tauri/src/integrations/mod.rs` and `integrations/email/`
      submodule tree.
- [ ] `EmailProvider` enum + `PRESETS` constant in `provider.rs`.
- [ ] `EmailAccount` struct + validation in `auth.rs`.
- [ ] `NormalizedMessage` and `EmailListing` types in `parser.rs`.
- [ ] Unit tests for `mail-parser`-based normalization using a few canned
      RFC 5322 fixtures (plain text, HTML, mixed multipart, attachments,
      non-ASCII subject).

### 10.1b — IMAP client

- [ ] `imap_client.rs` wrapping `async-imap` + `tokio-rustls`:
  - `connect_and_login(account: &EmailAccount) -> Result<ImapSession>`
  - `list_recent(session: &mut ImapSession, filters: ListFilters) -> Result<Vec<EmailListing>>`
  - `fetch_full(session: &mut ImapSession, message_id: &str) -> Result<NormalizedMessage>`
- [ ] SEARCH query construction from `ListFilters` (date range, FROM,
      SUBJECT).
- [ ] FETCH envelope + BODY.PEEK[HEADER] + BODY.PEEK[TEXT] for the read
      path (PEEK to avoid marking messages as read).
- [ ] Connection pooling decision: do we re-connect per call, or keep a
      cached session per account? Default: reconnect per call for Phase
      10.1, revisit if latency is painful.
- [ ] Integration tests gated behind an env var that provides a real test
      account's credentials (never checked in; run manually).

### 10.1c — SMTP stub

- [ ] `smtp_client.rs` with a `send_message` function that is implemented
      but guarded behind a `#[cfg(feature = "email_send")]` flag or a
      runtime check on `account.send_enabled`. Phase 10.1 leaves this
      dead code. Purpose: prove the compile path works and the crate
      dependency resolves cleanly before Phase 10.2.

### 10.1d — Sub-agent

- [ ] `sub_agent.rs` with `summarize_message(account_id, message_id, focus)`
      that:
  1. Fetches the full message via the IMAP client
  2. Extracts plain-text body (preferring `text/plain` part, falling back
     to `text/html` → plain conversion via a minimal HTML stripper)
  3. Strips quoted reply chains (best effort)
  4. Spawns a sub-agent chat completion using the same harness as
     `research_url` with the email summarizer system prompt
  5. Returns the summary + key metadata fields
- [ ] Fallback path: if the sub-agent call fails or times out, return
      `{ summary: snippet + " [summarization unavailable]" }` so the tool
      call still returns useful data.

### 10.1e — Tauri commands

- [ ] `email_list_providers` — returns the preset list for the UI dropdown.
- [ ] `email_test_connection` — validates an `EmailAccount` by connecting
      and logging in (no FETCH). Returns OK / error with a friendly message.
- [ ] `email_list_recent` — the list tool handler.
- [ ] `email_summarize_message` — the sub-agent handler.
- [ ] `email_read_full` — the escape-hatch handler.
- [ ] Register all of the above in `lib.rs` `.invoke_handler(...)`.

### 10.1f — Settings UI

- [ ] Extend `AppSettings` TypeScript interface with `integrations.email.accounts`.
- [ ] Deep-merge-on-load upgrade handling (same pattern as `inferenceBackend`).
- [ ] New `IntegrationsSettings.svelte` section on the Settings page
      containing an accounts list, an "Add account" button, and per-account
      rows with edit/delete/enable controls.
- [ ] New `EmailAccountForm.svelte` component with:
  - Provider preset dropdown
  - Label, email address, password fields
  - IMAP/SMTP host + port fields (auto-filled by preset, editable for
    Custom)
  - "Test connection" button wired to `email_test_connection`
  - "Generate app password" link pointing at the preset's docs URL
  - `sendEnabled` checkbox (greyed-out in 10.1 with a "Phase 10.2" note)

### 10.1g — Agent loop wiring

- [ ] New `email_list_recent` / `email_summarize_message` / `email_read_full`
      tool schemas in `src/lib/agent/tools.ts`.
- [ ] `VISION_DEPENDENT_TOOLS` → add a similar `EMAIL_DEPENDENT_TOOLS`
      (or a general "enabled integrations" filter) so tools are only
      exposed when at least one email account is enabled.
- [ ] `executeEmailListRecent`, `executeEmailSummarizeMessage`,
      `executeEmailReadFull` wrappers in `search.ts` returning `ToolExecOutput`.
- [ ] New dispatch cases in the `executeTool` switch.
- [ ] Conditional system prompt addition in `buildSystemPrompt`.

### 10.1h — Documentation + verification

- [ ] New "Email integration" section in the README documenting:
  - Current state (read-only, multi-provider)
  - Supported providers with links to their app-password docs
  - Privacy / security posture
  - Known limitations (no Outlook, no attachments, no threading)
- [ ] Manual test matrix against at least 2 providers (Gmail + Fastmail).
- [ ] The usual `cargo test` / `cargo clippy` / `npm run check` / `npm run lint`
      / `npm run format:check` pass.

---

## Phase 10.2 Preview — Sending Email

This section is intentionally vague — it exists to make sure 10.1 doesn't
accidentally paint us into a corner. Full design for 10.2 will be a separate
doc.

- SMTP via `lettre` to the same per-account endpoint stored in 10.1.
- New tool: `email_send` with a mandatory confirmation step before the
  message actually goes out. Options: (a) always require user confirmation
  in the chat UI, (b) provide a "draft" flow where the model produces a
  draft and the user clicks a Send button, (c) allow autonomous sending
  when explicitly authorized. Almost certainly we start with (b).
- `account.sendEnabled` gates the tool's visibility — accounts opt into
  sending separately from reading.
- System prompt additions for safe sending behavior (no autonomous
  sending, always show the full body to the user before dispatch, etc.).
- Rate-limiting / anti-abuse guards so a runaway agent can't blast a
  hundred messages.

---

## Future Phase Roadmap

- **Phase 10.2** — Email sending via SMTP. Built on the credential shape
  and module structure from 10.1.
- **Phase 10.3** — Rich email features: attachments (read + write),
  folder/label browsing, full threading, draft management.
- **Phase 10.4** — OAuth support. Enables Microsoft 365 / Outlook, enables
  Gmail users to skip the app-password flow, future-proofs against further
  basic-auth deprecation. Revisits the "user brings their own OAuth app"
  vs "Haruspex ships a verified OAuth app" question.
- **Phase 11** — Google Calendar integration. Likely reuses Phase 10.4
  OAuth infrastructure if we've shipped it; otherwise uses read-only
  calendar-specific credentials if Google exposes them.
- **Phase 12** — Google Drive + Docs integration. Same OAuth story.
- **Phase 13+** — MCP architecture reassessment. Once the integration
  count is high enough that maintaining N first-party clients becomes
  noisy, revisit the MCP client approach for the long tail of
  integrations (Slack, Notion, GitHub, Linear, etc.).

---

## Privacy and Security Posture

This section exists so we can point at it when someone asks "but is my
email safe?"

- **Credentials stay on the user's device.** App passwords live in the
  existing settings blob in the app's data directory — same trust level
  as the Brave API key, the remote inference key, and the SQLite chat
  history. No cloud sync.
- **No telemetry.** Haruspex doesn't phone home about integration usage.
  We have no "users who connected email" metric; we don't track tool
  calls; we don't upload message content anywhere outside the direct IMAP
  connection to the provider.
- **Provider endpoints are the only external network destinations.** Each
  configured account connects only to its own IMAP host (e.g.
  `imap.gmail.com:993`). No third-party proxy, no "email summary service"
  in the middle.
- **The user's chosen LLM backend is where email content ends up.**
  Message bodies flow through the configured inference backend (local
  llama-server by default, or a user-configured remote server). Users
  running in local-sidecar mode can see every byte of their email in the
  LLM's context and know it never left their machine. Users running
  against a remote inference server are trusting that server with their
  email content — same tradeoff as using the remote backend for anything
  else, explicitly documented in the "Remote inference server" section
  of the README.
- **Sub-agent summaries still flow through the user's LLM.** The sub-agent
  is a separate chat completion, but it uses the same inference backend —
  there is no third party involved in summarization.
- **Opt-in by default.** The integration is off until the user adds an
  account and enables it in Settings. A fresh install behaves exactly
  like before.
- **Tools invisible when disabled.** Email tools aren't exposed to the
  model at all until at least one account is enabled — the model can't
  accidentally call a tool that doesn't work, and we don't waste tokens
  on descriptions for unavailable tools.
- **No surprise email reads.** The system prompt tells the model only to
  call email tools when the user has asked about email — not to
  proactively "check for new messages" or "see if there's anything
  urgent."
- **Read-only for Phase 10.1.** There's no path from "the model decides
  something" to "an email gets sent." Sending is Phase 10.2 with separate
  safety design and its own opt-in toggle per account.
- **BODY.PEEK preserves unread state.** The IMAP client uses `BODY.PEEK[]`
  rather than `BODY[]` so reading a message doesn't mark it as seen in
  the user's inbox.

---

## Open Questions for Phase 10.2+ (not blocking 10.1)

These are the decisions I'm deferring until after 10.1 ships. Noting them
here so we don't forget them.

1. **Send confirmation UX.** Does the model emit an `email_send` tool call
   that shows up in chat as a "Send this?" button, or does it produce a
   draft structure that the user edits in a side panel before clicking
   Send? The first is simpler; the second is safer.
2. **Draft persistence.** If the user starts composing via the model and
   then closes the chat, does the draft survive? If yes, where does it
   live — the settings blob, a new SQLite table, the provider's Drafts
   folder via IMAP APPEND?
3. **Attachment storage.** When the model downloads an attachment, does
   it land in the working directory (reusing the existing `fs_*` tools)
   or in a dedicated cache? Probably the working directory, but worth
   confirming.
4. **Threading model.** IMAP has no native thread concept. Do we group
   by References / In-Reply-To headers ourselves, or do we expose the
   flat message list and let the model figure it out from subjects +
   dates? Flat for 10.1, revisit for 10.3.
5. **Multi-account account picker.** When the user says "summarize recent
   email" without naming an account, do we query all enabled accounts and
   merge, or do we pick a default, or do we ask? Current answer: query
   all enabled accounts concurrently, merge by date desc.

---

## Glossary

- **IMAP** — Internet Message Access Protocol. Old but universal
  email-fetching protocol. Every mainstream email provider (except
  Microsoft 365, which killed basic auth) supports it.
- **SMTP** — Simple Mail Transfer Protocol. The sending side of email.
  Used in Phase 10.2.
- **App password** — A per-app 16-char password that providers let you
  generate after enabling 2FA. Used with protocols like IMAP and SMTP
  that don't natively support OAuth. Still works for Gmail, Fastmail,
  iCloud, and Yahoo as of 2026; deprecated for Microsoft.
- **Sub-agent** — A separate chat completion spawned by a tool to compress
  expensive input before it reaches the main agent. Haruspex already uses
  this pattern in `research_url`; `email_summarize_message` is the second
  instance.
- **MIME** — Multipurpose Internet Mail Extensions. The standard for
  encoding attachments, HTML bodies, and non-ASCII text in email
  messages. Handled by the `mail-parser` crate.
- **SASL XOAUTH2** — The SASL mechanism for authenticating IMAP/SMTP
  sessions with an OAuth access token. Relevant for Phase 10.4.
- **MCP (Model Context Protocol)** — Anthropic's open protocol for AI
  apps to talk to external tools via separate server processes.
  Deferred to Phase 13+ in this roadmap.
