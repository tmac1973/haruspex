# Phase 10 — A secret store; email passwords move into it

Depends on: — / Enables: 11

## Goal

Email passwords leave the settings blob for the OS keychain: Secret Service
on Linux, Keychain on macOS, Credential Manager on Windows. Today every
credential Haruspex holds is plain text in the localStorage settings
(`settings.ts:725`, `:837`).

**The approach:**
- **A general store.** This phase builds a small `secrets` module that any
  secret can use, and moves email passwords first. Sending mail (phase 11)
  raises what a leaked password can do. Moving the API keys is a separate
  `futures.md` item.
- **The frontend never holds a stored password.** It holds a reference, and
  Rust resolves it when it connects.
- **Fallback.** Where no keychain is available (decision 2), the password
  stays in the settings blob as today, and Settings → Email says so.

## Files touched

- `src-tauri/Cargo.toml`: the `keyring` crate (v3), with the platform
  features for Secret Service (sync), Apple native and Windows native.
- New `src-tauri/src/secrets.rs`; `src-tauri/src/lib.rs` registers its
  commands.
- `src-tauri/src/integrations/email/auth.rs`: `password_ref`, and how a
  password is resolved.
- `src-tauri/src/integrations/email/commands.rs` and `imap_client.rs`:
  resolve before connecting.
- `src/lib/stores/settings.ts`: migration on load; account save and delete.
- `src/lib/components/EmailAccountForm.svelte` and
  `settings/EmailSection.svelte`: where the password is kept, and the
  fallback notice.
- Tests; `./scripts/export-ipc-types.sh`.

## Steps

1. **`secrets.rs`.**
   - Service name `com.haruspex.app`; entries keyed by a caller-chosen
     string.
   - Functions: `available() -> bool`, `set(key, value)`, `get(key) ->
     Option<String>`, `delete(key)`.
   - `available()` writes, reads back and deletes a probe entry once per
     process and caches the answer. A Secret Service with no unlocked
     collection, or a headless box, reads as unavailable.
   - Errors are strings naming the platform store, for example "the system
     keychain refused the write: …".
   - Commands: `secret_available`, `secret_set`, `secret_delete`. There is
     deliberately no `secret_get` command: values only leave the store inside
     Rust.
2. **`EmailAccount` gains `password_ref: Option<String>`.**
   - When it is set, `password` is empty in storage, and Rust takes the
     password from `secrets::get(password_ref)` at connect time.
   - A missing secret is the error "The password for <address> is missing
     from the system keychain — enter it again in Settings → Email".
   - `validate()` accepts an empty password when `password_ref` is set.
3. **Saving an account.** Today the form writes settings on every edit
   (`EmailAccountForm.svelte:55-72`), and a keychain write per keystroke is
   wrong. Add an explicit **Save** button, enabled when the account has
   changed. Other fields keep saving as they do now; the password is only
   committed on Save.
   - If `secret_available`:
     1. `secret_set("email:<account id>", password)`;
     2. store the account with `password: ''` and
        `password_ref: "email:<account id>"`.
   - Otherwise keep the password inline, as today.
   - On Save, test the connection first. `testConnection` builds its own
     payload (around :94-108); include `passwordRef` in it, so an edit that
     leaves the password empty tests with the stored secret.
4. **Editing an account.** The password field shows a placeholder, "Saved in
   the system keychain", and stays empty. Typing a new value replaces the
   secret on save; leaving it empty keeps the stored one.
5. **Deleting an account** deletes its secret. Failures are logged and never
   block the delete.
6. **Migration after load.** There is no settings version, and `load()` is
   synchronous (`settings.ts:723`).
   - Add an async `migrateEmailSecrets()`, called once after settings load
     at app start.
   - It is idempotent: it acts only on accounts with a non-empty `password`
     and no `password_ref`, so running it every start is harmless.
   - When the keychain is available, it moves each such password in, clears
     it, sets the ref, and saves.
   - A failure leaves that account untouched and logs why.
7. **Fallback notice.** When `secret_available` is false, Settings → Email
   shows one line: "No system keychain found — passwords are kept in
   Haruspex's settings." The tooltip says how to enable one: on Linux, a
   Secret Service such as GNOME Keyring or KWallet.
8. **README.** The Email integration section (around `README.md:315`) says
   there is no system keyring. Replace that with: passwords are kept in the
   system keychain where one exists.

## Build gate

The overview's gate. `cargo test` must pass on CI without a keychain, so
tests use an in-memory mock behind the same functions: a `cfg(test)` backend,
or `keyring`'s mock credential builder.

## Test plan

- **Rust:**
  - set/get/delete round-trip on the mock;
  - `available()` is false when the mock refuses writes;
  - an account with a ref and no password resolves through the store;
  - a missing secret gives the Settings → Email error.
- **TS, migration:**
  - an inline password moves out and gets a ref when available;
  - it stays inline when unavailable;
  - a second run does nothing.
- **TS, form:**
  - typing a password calls no secret command until Save;
  - a save with the keychain available stores a ref and an empty password;
  - a save with an empty password field during an edit keeps the existing
    ref;
  - a delete calls `secret_delete`.
- **Manual:**
  - on Linux with KWallet or GNOME Keyring: an existing account migrates on
    start, and the password appears in the keyring tool under
    `com.haruspex.app`;
  - listing mail still works;
  - the settings JSON in localStorage no longer contains it.
  - On a session with no Secret Service (a bare TTY login, or one with the
    service masked): the notice shows and mail still works.

## Commit

`feat(email): keep account passwords in the system keychain`

## Rollback

Revert the commit.

Migrated passwords stay in the keychain, but the old code reads only the
inline field, so those accounts lose their password. **Before reverting,**
ship a one-off restore: read each `password_ref` back through Rust and write
it inline. Otherwise, after reverting, re-enter each password in Settings →
Email.
