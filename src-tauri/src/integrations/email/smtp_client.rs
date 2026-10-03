//! Sending mail over SMTP.
//!
//! Nothing here sends on its own initiative: `email_send` is invoked only by
//! the review dialog's Send button, after the user has read and edited the
//! draft. The model can open a draft (`email_compose`); it cannot send one.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use lettre::message::header::{ContentTransferEncoding, ContentType};
use lettre::message::{Body, Mailbox, Message, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use serde::{Deserialize, Serialize};

use super::auth::{self, EmailAccount};
use super::parser::NormalizedMessage;
use super::provider::TlsMode;

/// The limit on each SMTP exchange.
const SMTP_TIMEOUT: Duration = Duration::from_secs(30);

/// The limit on a whole send or test. lettre's own timeout covers each
/// exchange but not the wait for the server's greeting, so a server that
/// accepts and never speaks is caught here.
const CALL_LIMIT: Duration = Duration::from_secs(45);

/// How much of the original a reply quotes.
const QUOTE_MAX_CHARS: usize = 8_000;

/// A message the user approved in the review dialog.
#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMessage {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    pub subject: String,
    pub body: String,
    /// The Message-ID being replied to, without angle brackets.
    #[serde(default)]
    #[ts(optional)]
    pub in_reply_to: Option<String>,
    /// The thread's Message-IDs, oldest first, without angle brackets.
    #[serde(default)]
    pub references: Vec<String>,
}

/// A new Message-ID at the sender's domain: time, process and a counter, so
/// two drafts in the same instant still differ.
pub fn new_message_id(from: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let domain = from.rsplit_once('@').map(|(_, d)| d).unwrap_or("localhost");
    format!("{nanos:x}.{:x}.{n}.haruspex@{domain}", std::process::id())
}

fn mailbox(addr: &str, field: &str) -> Result<Mailbox, String> {
    addr.trim()
        .parse()
        .map_err(|e| format!("{field} address {addr:?} is not valid: {e}"))
}

/// Build the message: Date, a new Message-ID, plain UTF-8 text in
/// quoted-printable, and the threading headers for a reply.
pub fn build_message(
    account: &EmailAccount,
    msg: &OutgoingMessage,
    message_id: &str,
) -> Result<Message, String> {
    if msg.to.is_empty() {
        return Err("The message has no recipient".into());
    }
    let mut b = Message::builder()
        .from(mailbox(&account.email_address, "From")?)
        .subject(msg.subject.clone())
        .date_now()
        .message_id(Some(format!("<{message_id}>")));
    for to in &msg.to {
        b = b.to(mailbox(to, "To")?);
    }
    for cc in &msg.cc {
        b = b.cc(mailbox(cc, "Cc")?);
    }
    if let Some(parent) = msg.in_reply_to.as_deref().filter(|s| !s.is_empty()) {
        b = b.in_reply_to(format!("<{parent}>"));
    }
    if !msg.references.is_empty() {
        let refs: Vec<String> = msg.references.iter().map(|r| format!("<{r}>")).collect();
        b = b.references(refs.join(" "));
    }
    let body = Body::new_with_encoding(msg.body.clone(), ContentTransferEncoding::QuotedPrintable)
        .map_err(|_| "The message body could not be encoded".to_string())?;
    b.singlepart(
        SinglePart::builder()
            .header(ContentType::TEXT_PLAIN)
            .body(body),
    )
    .map_err(|e| format!("The message could not be built: {e}"))
}

fn transport(account: &EmailAccount) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let host = account.smtp_host.trim();
    let params = TlsParameters::new(host.to_string())
        .map_err(|e| format!("TLS setup for {host} failed: {e}"))?;
    // STARTTLS is required, never opportunistic: no password in the clear.
    let tls = match account.smtp_tls {
        TlsMode::Implicit => Tls::Wrapper(params),
        TlsMode::Starttls => Tls::Required(params),
    };
    Ok(build_transport(host, account.smtp_port, tls, account))
}

fn build_transport(
    host: &str,
    port: u16,
    tls: Tls,
    account: &EmailAccount,
) -> AsyncSmtpTransport<Tokio1Executor> {
    AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
        .port(port)
        .tls(tls)
        .credentials(Credentials::new(
            account.email_address.clone(),
            account.password.clone(),
        ))
        .timeout(Some(SMTP_TIMEOUT))
        .build()
}

/// An SMTP failure as a sentence naming the host.
fn smtp_error(host: &str, e: &lettre::transport::smtp::Error) -> String {
    let text = e.to_string();
    if e.is_timeout() {
        format!("{host} did not answer within {} s", SMTP_TIMEOUT.as_secs())
    } else if text.contains("535") || text.contains("534") || text.to_lowercase().contains("auth") {
        format!("{host} refused the login — check the app password in Settings → Email ({text})")
    } else {
        format!("Sending through {host} failed: {text}")
    }
}

/// Run `fut` under an outer limit ([`CALL_LIMIT`] in the app).
async fn bounded<T>(
    host: &str,
    limit: Duration,
    fut: impl std::future::Future<Output = Result<T, lettre::transport::smtp::Error>>,
) -> Result<T, String> {
    match tokio::time::timeout(limit, fut).await {
        Ok(r) => r.map_err(|e| smtp_error(host, &e)),
        Err(_) => Err(format!(
            "{host} did not answer within {} s",
            limit.as_secs()
        )),
    }
}

fn require_sending(account: &EmailAccount) -> Result<(), String> {
    if !account.send_enabled {
        return Err(format!(
            "Sending is off for {} — turn on Allow sending in Settings → Email",
            account.email_address
        ));
    }
    if account.smtp_host.trim().is_empty() || account.smtp_port == 0 {
        return Err(format!(
            "No SMTP server is set for {} — Settings → Email",
            account.email_address
        ));
    }
    Ok(())
}

/// Connect and log in to the SMTP server without sending anything.
pub async fn test_smtp(account: &EmailAccount) -> Result<(), String> {
    let account = auth::resolve(account).await?;
    if account.smtp_host.trim().is_empty() || account.smtp_port == 0 {
        return Err("Enter the SMTP host and port first".into());
    }
    let t = transport(&account)?;
    let ok = bounded(&account.smtp_host, CALL_LIMIT, t.test_connection()).await?;
    if ok {
        Ok(())
    } else {
        Err(format!("{} closed the connection", account.smtp_host))
    }
}

/// What a send produced: the new message's id, and its bytes for the copy
/// in Sent.
pub struct Sent {
    pub message_id: String,
    pub raw: Vec<u8>,
}

/// Send one message.
pub async fn send_message(account: &EmailAccount, msg: &OutgoingMessage) -> Result<Sent, String> {
    require_sending(account)?;
    let account = auth::resolve(account).await?;
    let message_id = new_message_id(&account.email_address);
    let message = build_message(&account, msg, &message_id)?;
    let raw = message.formatted();
    let t = transport(&account)?;
    bounded(&account.smtp_host, CALL_LIMIT, t.send(message)).await?;
    Ok(Sent { message_id, raw })
}

/// What a reply starts from: who it goes to, its subject and threading
/// headers, and the original quoted.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReplyContext {
    /// Reply-To, else From — never the user's own address.
    pub to: Vec<String>,
    /// For reply-all: the original To and Cc, less the user and `to`.
    pub cc_all: Vec<String>,
    /// "Re: " and the original subject, not doubled.
    pub subject: String,
    pub in_reply_to: String,
    /// The original's References plus its Message-ID.
    pub references: Vec<String>,
    /// "On <date>, <sender> wrote:" and the original, `>`-quoted.
    pub quoted: String,
}

fn same_address(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// "Re: " once.
pub fn reply_subject(subject: &str) -> String {
    let s = subject.trim();
    if s.len() >= 3 && s[..3].eq_ignore_ascii_case("re:") {
        s.to_string()
    } else {
        format!("Re: {s}")
    }
}

/// The reply to `original`, for the account whose address is `own`.
pub fn reply_context(original: &NormalizedMessage, own: &str) -> ReplyContext {
    let sender = if original.reply_to.is_empty() {
        original.from_email.clone()
    } else {
        original.reply_to.clone()
    };
    // Replying to one's own message goes to whoever it was sent to.
    let to: Vec<String> = if same_address(&sender, own) {
        original.to.clone()
    } else {
        vec![sender]
    };
    let mut cc_all: Vec<String> = Vec::new();
    for a in original.to.iter().chain(original.cc.iter()) {
        let taken = same_address(a, own)
            || to.iter().any(|t| same_address(t, a))
            || cc_all.iter().any(|c| same_address(c, a));
        if !taken {
            cc_all.push(a.clone());
        }
    }

    let mut references = original.references.clone();
    if !original.rfc_message_id.is_empty() && !references.contains(&original.rfc_message_id) {
        references.push(original.rfc_message_id.clone());
    }

    // "2026-04-07T10:14:00Z" → "2026-04-07 10:14 UTC".
    let when = if original.date.len() >= 16 {
        format!("{} UTC", original.date[..16].replace('T', " "))
    } else {
        original.date.clone()
    };
    let who = if original.from_name.is_empty() {
        original.from_email.clone()
    } else {
        format!("{} <{}>", original.from_name, original.from_email)
    };
    let body: String = original.body.chars().take(QUOTE_MAX_CHARS).collect();
    let quoted_lines: Vec<String> = body
        .lines()
        .map(|l| {
            if l.is_empty() {
                ">".to_string()
            } else {
                format!("> {l}")
            }
        })
        .collect();
    let quoted = format!("On {when}, {who} wrote:\n{}", quoted_lines.join("\n"));

    ReplyContext {
        to,
        cc_all,
        subject: reply_subject(&original.subject),
        in_reply_to: original.rfc_message_id.clone(),
        references,
        quoted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::email::provider::EmailProvider;

    fn sample_account() -> EmailAccount {
        EmailAccount {
            id: "acc".into(),
            label: "Test".into(),
            enabled: true,
            send_enabled: true,
            provider: EmailProvider::Custom,
            email_address: "me@example.com".into(),
            password: "pw".into(),
            password_ref: None,
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            imap_tls: TlsMode::Implicit,
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            smtp_tls: TlsMode::Implicit,
        }
    }

    fn original() -> NormalizedMessage {
        NormalizedMessage {
            account_id: "acc".into(),
            account_label: "Test".into(),
            message_id: "7:1".into(),
            subject: "Plan for Tuesday".into(),
            from_name: "Alice".into(),
            from_email: "alice@example.com".into(),
            to: vec!["me@example.com".into(), "bob@example.com".into()],
            cc: vec!["carol@example.com".into(), "ME@example.com".into()],
            reply_to: String::new(),
            date: "2026-04-07T10:14:00Z".into(),
            body: "Can you make it?\n\nThanks".into(),
            has_attachments: false,
            rfc_message_id: "m2@example.com".into(),
            in_reply_to: "m1@example.com".into(),
            references: vec!["m1@example.com".into()],
        }
    }

    fn draft() -> OutgoingMessage {
        OutgoingMessage {
            to: vec!["alice@example.com".into()],
            cc: vec![],
            subject: "Re: Plan for Tuesday".into(),
            body: "Yes — see you then.".into(),
            in_reply_to: Some("m2@example.com".into()),
            references: vec!["m1@example.com".into(), "m2@example.com".into()],
        }
    }

    fn text(m: &Message) -> String {
        String::from_utf8_lossy(&m.formatted()).into_owned()
    }

    #[test]
    fn a_reply_carries_date_id_and_threading() {
        let m = build_message(&sample_account(), &draft(), "new@example.com").unwrap();
        let t = text(&m);
        assert!(t.contains("Date: "), "{t}");
        assert!(t.contains("Message-ID: <new@example.com>"), "{t}");
        assert!(t.contains("In-Reply-To: <m2@example.com>"), "{t}");
        assert!(
            t.contains("References: <m1@example.com> <m2@example.com>"),
            "{t}"
        );
        assert!(
            t.contains("Content-Transfer-Encoding: quoted-printable"),
            "{t}"
        );
    }

    #[test]
    fn non_ascii_subjects_and_bodies_are_encoded() {
        let mut d = draft();
        d.subject = "Grüße aus Köln".into();
        d.body = "Schöne Grüße".into();
        let t = text(&build_message(&sample_account(), &d, "x@example.com").unwrap());
        assert!(t.contains("Subject: =?utf-8?"), "{t}");
        assert!(t.contains("Sch=C3=B6ne Gr=C3=BC=C3=9Fe"), "{t}");
    }

    #[test]
    fn re_is_not_doubled() {
        assert_eq!(reply_subject("Plan"), "Re: Plan");
        assert_eq!(reply_subject("RE: Plan"), "RE: Plan");
        assert_eq!(reply_subject("re:Plan"), "re:Plan");
    }

    #[test]
    fn a_reply_goes_to_the_sender_and_reply_all_leaves_the_user_out() {
        let c = reply_context(&original(), "me@example.com");
        assert_eq!(c.to, vec!["alice@example.com"]);
        assert_eq!(c.cc_all, vec!["bob@example.com", "carol@example.com"]);
        assert_eq!(c.subject, "Re: Plan for Tuesday");
        assert_eq!(c.references, vec!["m1@example.com", "m2@example.com"]);
        assert_eq!(c.in_reply_to, "m2@example.com");
        assert!(c
            .quoted
            .starts_with("On 2026-04-07 10:14 UTC, Alice <alice@example.com> wrote:\n> Can you make it?\n>\n> Thanks"));
    }

    #[test]
    fn reply_to_wins_over_from() {
        let mut o = original();
        o.reply_to = "list@example.com".into();
        assert_eq!(
            reply_context(&o, "me@example.com").to,
            vec!["list@example.com"]
        );
    }

    #[test]
    fn replying_to_ones_own_message_goes_to_its_recipients() {
        let mut o = original();
        o.from_email = "me@example.com".into();
        let c = reply_context(&o, "me@example.com");
        assert_eq!(c.to, vec!["me@example.com", "bob@example.com"]);
    }

    #[test]
    fn sending_is_refused_when_it_is_off() {
        let mut a = sample_account();
        a.send_enabled = false;
        assert!(require_sending(&a).unwrap_err().contains("Allow sending"));
    }

    /// Just enough SMTP for lettre: greeting, EHLO, AUTH, MAIL, RCPT, DATA,
    /// QUIT. Returns what DATA carried.
    async fn fake_smtp(listener: tokio::net::TcpListener) -> String {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (sock, _) = listener.accept().await.unwrap();
        let (r, mut w) = sock.into_split();
        let mut lines = BufReader::new(r).lines();
        w.write_all(b"220 fake ESMTP\r\n").await.unwrap();
        let mut data = String::new();
        let mut in_data = false;
        while let Ok(Some(line)) = lines.next_line().await {
            if in_data {
                if line == "." {
                    in_data = false;
                    w.write_all(b"250 queued\r\n").await.unwrap();
                } else {
                    data.push_str(&line);
                    data.push('\n');
                }
                continue;
            }
            let upper = line.to_ascii_uppercase();
            let reply: &[u8] = if upper.starts_with("EHLO") {
                b"250-fake\r\n250 AUTH PLAIN LOGIN\r\n"
            } else if upper.starts_with("AUTH") {
                b"235 ok\r\n"
            } else if upper.starts_with("DATA") {
                in_data = true;
                b"354 go\r\n"
            } else if upper.starts_with("QUIT") {
                w.write_all(b"221 bye\r\n").await.unwrap();
                break;
            } else {
                b"250 ok\r\n"
            };
            w.write_all(reply).await.unwrap();
        }
        data
    }

    #[tokio::test]
    async fn a_local_server_receives_the_message() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(fake_smtp(listener));
        let account = sample_account();
        let t = build_transport("127.0.0.1", port, Tls::None, &account);
        let m = build_message(&account, &draft(), "id@example.com").unwrap();
        bounded("127.0.0.1", CALL_LIMIT, t.send(m)).await.unwrap();
        let data = server.await.unwrap();
        assert!(data.contains("Message-ID: <id@example.com>"), "{data}");
        assert!(data.contains("To: alice@example.com"), "{data}");
    }

    #[tokio::test]
    async fn a_silent_server_fails_within_the_limit() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hold = tokio::spawn(async move {
            let (_sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(120)).await;
        });
        let account = sample_account();
        let t = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
            .port(port)
            .tls(Tls::None)
            .timeout(Some(Duration::from_millis(300)))
            .build();
        let m = build_message(&account, &draft(), "id@example.com").unwrap();
        let started = std::time::Instant::now();
        let err = bounded("127.0.0.1", Duration::from_millis(500), t.send(m))
            .await
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(err.contains("127.0.0.1"), "{err}");
        hold.abort();
    }
}
