//! SMTP client stub — becomes a real send path in Phase 10.2.
//!
//! Phase 10.1 is read-only, so the only reason this file exists is
//! to prove the `lettre` dependency resolves, compiles, and works
//! with our `tokio-rustls` TLS stack. Shipping the dep with 10.1
//! means 10.2 is purely code — no Cargo.toml churn, no surprise
//! version conflicts six months from now when we finally get to
//! sending.
//!
//! The public shape intentionally matches where Phase 10.2 will
//! land. Every item in this file is `#[allow(dead_code)]` because
//! nothing calls it yet — the whole point of the stub is that it
//! compiles now so 10.2 can fill it in without touching Cargo.toml
//! or this file's public API.
//!
//! - `OutgoingMessage` — what the caller hands us.
//! - `send_message(account, msg)` — the single entry point the
//!   `email_send` Tauri command will wrap.
//!
//! In 10.1 the body of `send_message` is a single guard that
//! returns a "not implemented" error. We don't want to accidentally
//! send real email before the confirmation UX is built.

#![allow(dead_code)]

use lettre::message::{header::ContentType, Mailbox, Message};

use super::auth::EmailAccount;

/// Minimal "outgoing message" shape. Phase 10.2 will add
/// attachments, HTML alternatives, Reply-To, and threading
/// headers — they're deliberately absent here so 10.1 can't be
/// mis-used to send anything beyond the simplest plaintext email.
#[derive(Debug, Clone)]
pub struct OutgoingMessage {
    pub to: Vec<String>,
    pub subject: String,
    pub body_plain: String,
}

/// Build a `lettre::Message` from our simple struct. Kept separate
/// from `send_message` so it can be unit tested without a network.
pub fn build_message(account: &EmailAccount, msg: &OutgoingMessage) -> Result<Message, String> {
    let from: Mailbox = account
        .email_address
        .parse()
        .map_err(|e| format!("Invalid From address {:?}: {e}", account.email_address))?;

    let mut builder = Message::builder().from(from).subject(msg.subject.clone());

    if msg.to.is_empty() {
        return Err("OutgoingMessage.to is empty".into());
    }
    for to_addr in &msg.to {
        let mbox: Mailbox = to_addr
            .parse()
            .map_err(|e| format!("Invalid To address {to_addr:?}: {e}"))?;
        builder = builder.to(mbox);
    }

    builder
        .header(ContentType::TEXT_PLAIN)
        .body(msg.body_plain.clone())
        .map_err(|e| format!("lettre Message::body failed: {e}"))
}

/// Placeholder send path. In Phase 10.1 this always refuses —
/// sending is intentionally unimplemented until the confirmation
/// UX (Phase 10.2) is in place.
///
/// The signature is what Phase 10.2 will use: async, takes the
/// account + message, returns a success-or-error string. Keeping
/// it stable now means the command handler + TS wrapper can be
/// written once.
#[allow(dead_code)]
pub async fn send_message(_account: &EmailAccount, _msg: &OutgoingMessage) -> Result<(), String> {
    Err("Email sending is not available in Phase 10.1 — \
         read-only integration only. See Phase 10.2 for send support."
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::email::provider::{EmailProvider, TlsMode};

    fn sample_account() -> EmailAccount {
        EmailAccount {
            id: "acc".into(),
            label: "Test".into(),
            enabled: true,
            send_enabled: true,
            provider: EmailProvider::Gmail,
            email_address: "sender@example.com".into(),
            password: "pw".into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            imap_tls: TlsMode::Implicit,
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            smtp_tls: TlsMode::Implicit,
        }
    }

    #[test]
    fn builds_valid_plaintext_message() {
        let msg = OutgoingMessage {
            to: vec!["recipient@example.com".into()],
            subject: "Hello".into(),
            body_plain: "world".into(),
        };
        let built = build_message(&sample_account(), &msg).expect("build");
        let serialized = built.formatted();
        let text = String::from_utf8_lossy(&serialized);
        assert!(text.contains("From: sender@example.com"));
        assert!(text.contains("To: recipient@example.com"));
        assert!(text.contains("Subject: Hello"));
        assert!(text.contains("world"));
    }

    #[test]
    fn rejects_missing_recipients() {
        let msg = OutgoingMessage {
            to: vec![],
            subject: "Nobody home".into(),
            body_plain: "hi".into(),
        };
        assert!(build_message(&sample_account(), &msg).is_err());
    }

    #[test]
    fn send_is_not_implemented_in_phase_10_1() {
        let msg = OutgoingMessage {
            to: vec!["a@example.com".into()],
            subject: "S".into(),
            body_plain: "B".into(),
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(send_message(&sample_account(), &msg));
        assert!(res.is_err(), "Phase 10.1 must refuse to send");
    }
}
