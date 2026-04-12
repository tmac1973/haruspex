//! Sub-agent body preparation.
//!
//! The actual summarizer chat-completion call lives in TypeScript
//! (`executeEmailSummarizeMessage` in `src/lib/agent/search.ts`), so
//! it can reuse the existing local-vs-remote inference routing. This
//! Rust-side helper is just the prep step: take a normalized message,
//! produce the compact "summarizer input" blob the TypeScript side
//! will feed into the sub-agent as its user turn.
//!
//! Keeping prep in Rust (as opposed to doing it in TypeScript) keeps
//! it close to the RFC 5322 parser. When Phase 10.2 adds attachment
//! handling or richer quote detection, this file is where that work
//! will accumulate.

use super::parser::{strip_quoted_replies, NormalizedMessage};

/// Hard ceiling on the number of characters we hand to the
/// summarizer. Keeps a runaway mailing-list digest from eating the
/// whole local context window. `parser::MAX_BODY_CHARS` already
/// truncates at 40k at read time; this is a secondary guard for
/// defensive layering.
const SUMMARIZER_INPUT_CAP: usize = 16_000;

/// Shape the sub-agent will consume. Renders as a plain-text block
/// on the TypeScript side — no serde involved.
#[derive(Debug, Clone)]
pub struct SummarizerInput {
    pub subject: String,
    pub from_name: String,
    pub from_email: String,
    pub date: String,
    pub body: String,
}

/// Strip quoted replies and hard-truncate the body, then package
/// the result into a `SummarizerInput`. Pure, no I/O.
pub fn prepare(msg: &NormalizedMessage) -> SummarizerInput {
    let stripped = strip_quoted_replies(&msg.body);
    let body = if stripped.chars().count() > SUMMARIZER_INPUT_CAP {
        let mut s = String::with_capacity(SUMMARIZER_INPUT_CAP + 32);
        for (n, c) in stripped.chars().enumerate() {
            if n >= SUMMARIZER_INPUT_CAP {
                break;
            }
            s.push(c);
        }
        s.push_str("\n\n[truncated for summarizer]");
        s
    } else {
        stripped
    };
    SummarizerInput {
        subject: msg.subject.clone(),
        from_name: msg.from_name.clone(),
        from_email: msg.from_email.clone(),
        date: msg.date.clone(),
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg_with_body(body: &str) -> NormalizedMessage {
        NormalizedMessage {
            account_id: "acc".into(),
            message_id: "1".into(),
            subject: "s".into(),
            from_name: "F".into(),
            from_email: "f@x".into(),
            to: vec![],
            date: "".into(),
            body: body.into(),
            has_attachments: false,
        }
    }

    #[test]
    fn strips_quote_tail_before_summarizer() {
        let msg = msg_with_body("real content\n\nOn Tue wrote:\n> old\n> stuff");
        let prepared = prepare(&msg);
        assert!(prepared.body.contains("real content"));
        assert!(!prepared.body.contains("old"));
    }

    #[test]
    fn caps_body_at_summarizer_limit() {
        let long = "x".repeat(SUMMARIZER_INPUT_CAP * 2);
        let msg = msg_with_body(&long);
        let prepared = prepare(&msg);
        assert!(prepared.body.chars().count() <= SUMMARIZER_INPUT_CAP + 40);
        assert!(prepared.body.contains("[truncated"));
    }
}
