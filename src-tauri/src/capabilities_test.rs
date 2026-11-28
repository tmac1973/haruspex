//! The app's ACL as it resolves at run time, from what tauri-build wrote for
//! this build (`gen/schemas/`): which windows may call which app commands.
//!
//! Windows that run agent turns (main, `shell-*`, `code-*`) get every
//! command; windows that run none (`editor-*`, `print-*`, `preview-*`) get
//! every command but the `no-agent-window` set (`permissions/`), so a script
//! that got into one can't read a secret, start a process, pair a computer or
//! send mail. See `capabilities/` and `build.rs`.

use std::collections::BTreeMap;

use tauri::utils::acl::capability::Capability;
use tauri::utils::acl::manifest::Manifest;
use tauri::utils::acl::resolved::{Resolved, ResolvedCommand};
use tauri::utils::platform::Target;

fn resolved() -> Resolved {
    let acl: BTreeMap<String, Manifest> =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let capabilities: BTreeMap<String, Capability> =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    Resolved::resolve(&acl, capabilities, Target::current()).unwrap()
}

fn reaches(entries: Option<&Vec<ResolvedCommand>>, window: &str) -> bool {
    entries.is_some_and(|all| {
        all.iter()
            .any(|c| c.windows.iter().any(|w| w.matches(window)))
    })
}

/// Whether `window` may call app command `cmd`: granted, and not denied
/// (a deny wins, as in `RuntimeAuthority::resolve_access`).
fn may_call(r: &Resolved, cmd: &str, window: &str) -> bool {
    reaches(r.allowed_commands.get(cmd), window) && !reaches(r.denied_commands.get(cmd), window)
}

/// Every command in `generate_handler!`, as build.rs reads it.
fn app_commands() -> Vec<String> {
    let src = include_str!("lib.rs");
    let start = src.find("generate_handler![").unwrap() + "generate_handler![".len();
    let body = &src[start..];
    body[..body.find(']').unwrap()]
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| p.rsplit("::").next().unwrap().to_string())
        .collect()
}

const AGENT_WINDOWS: &[&str] = &["main", "shell-3", "code-7"];
const AGENTLESS_WINDOWS: &[&str] = &["editor-2", "print-4", "preview-9"];

#[test]
fn the_app_checks_its_own_commands() {
    assert!(resolved().has_app_acl);
}

#[test]
fn windows_that_run_turns_may_call_every_command() {
    let r = resolved();
    let commands = app_commands();
    assert!(commands.len() > 500, "read {} commands", commands.len());
    for cmd in &commands {
        for window in AGENT_WINDOWS {
            assert!(may_call(&r, cmd, window), "{window} can't call {cmd}");
        }
    }
}

#[test]
fn windows_that_run_no_turn_cannot_reach_secrets_processes_or_mail() {
    let r = resolved();
    for cmd in [
        "secret_get",
        "secret_set",
        "get_llama_api_key",
        "owner_client_pair",
        "peer_op",
        "shell_spawn",
        "run_command_capture",
        "mcp_run_setup_command",
        "email_send",
    ] {
        for window in AGENTLESS_WINDOWS {
            assert!(!may_call(&r, cmd, window), "{window} can call {cmd}");
        }
    }
}

#[test]
fn windows_that_run_no_turn_keep_everything_else() {
    let r = resolved();
    // What their pages and the root layout use.
    for cmd in [
        "webview_store_load",
        "editor_read_file",
        "print_document",
        "print_run",
        "open_url",
        "memory_count",
    ] {
        if !app_commands().iter().any(|c| c == cmd) {
            continue;
        }
        for window in AGENTLESS_WINDOWS {
            assert!(may_call(&r, cmd, window), "{window} can't call {cmd}");
        }
    }
}

#[test]
fn every_secret_command_is_denied_to_windows_that_run_no_turn() {
    // A new command of these kinds belongs in permissions/no-agent-window.toml.
    let r = resolved();
    let sensitive = [
        "secret_",
        "owner_client",
        "google_sign_",
        "peer_op",
        "remote_start",
    ];
    for cmd in app_commands()
        .iter()
        .filter(|c| sensitive.iter().any(|s| c.starts_with(s)))
        // Whether a store or a sign-in exists, never a value.
        .filter(|c| {
            ![
                "secret_available",
                "secret_store_kind",
                "google_sign_in_available",
            ]
            .contains(&c.as_str())
        })
    {
        assert!(
            !may_call(&r, cmd, "editor-1"),
            "editor windows can call {cmd}"
        );
    }
}
