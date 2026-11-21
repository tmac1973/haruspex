//! Camera alert emails: built here from fixed parts, never drafted by a model.
//!
//! The subject comes from the alert's kind and the camera's name; the model's
//! words (a caption, a reason, a digest) only ever reach the body's lines.
//! Recipients are the addresses the user typed in Settings → Cameras →
//! Alerts, passed in by the frontend and checked again here: one to five
//! valid addresses. Pictures go as JPEG attachments, at most
//! [`MAX_ATTACHMENTS`].

use lettre::message::header::{ContentTransferEncoding, ContentType};
use lettre::message::{Attachment, Body, Mailbox, Message, MultiPart, SinglePart};
use serde::{Deserialize, Serialize};

/// Most addresses an alert goes to.
pub const MAX_RECIPIENTS: usize = 5;
/// Most pictures one alert carries.
pub const MAX_ATTACHMENTS: usize = 6;

/// What an alert email is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum CameraAlertKind {
    /// An urgent event, as it happens.
    Urgent,
    /// Urgent events that followed the first within its window.
    FollowUp,
    /// No model can judge the cameras' events.
    Paused,
    /// A model is judging them again.
    Resumed,
    /// A Camera digest job's summary.
    Digest,
    /// Settings → Cameras → Alerts → Send test.
    Test,
}

/// One alert email, as the frontend describes it.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CameraAlert {
    pub kind: CameraAlertKind,
    /// The camera it is about; none for a digest, a pause or a test.
    #[serde(default)]
    #[ts(optional)]
    pub camera_name: Option<String>,
    /// The body, one line each.
    pub lines: Vec<String>,
    /// Events whose pictures to attach, in order.
    #[serde(default)]
    #[ts(type = "number[]")]
    pub event_ids: Vec<i64>,
    /// The Message-ID of the alert this follows, without angle brackets, so
    /// mail clients keep them in one thread.
    #[serde(default)]
    #[ts(optional)]
    pub thread_id: Option<String>,
}

/// The subject: fixed by the kind, with the camera's name or the date.
pub fn subject(alert: &CameraAlert, date: &str) -> String {
    let camera = alert
        .camera_name
        .as_deref()
        .map(|n| n.replace(['\r', '\n'], " "))
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "a camera".into());
    match alert.kind {
        CameraAlertKind::Urgent | CameraAlertKind::FollowUp => {
            format!("Haruspex: urgent — {}", camera.trim())
        }
        CameraAlertKind::Paused => "Haruspex: camera alerts paused".into(),
        CameraAlertKind::Resumed => "Haruspex: camera alerts resumed".into(),
        CameraAlertKind::Digest => format!("Haruspex: camera digest — {date}"),
        CameraAlertKind::Test => "Haruspex: camera alerts test".into(),
    }
}

/// The addresses as mailboxes: one to [`MAX_RECIPIENTS`], each valid.
pub fn recipients(to: &[String]) -> Result<Vec<Mailbox>, String> {
    if to.is_empty() {
        return Err("No address to send alerts to — Settings → Cameras → Alerts".into());
    }
    if to.len() > MAX_RECIPIENTS {
        return Err(format!(
            "Alerts go to at most {MAX_RECIPIENTS} addresses — Settings → Cameras → Alerts"
        ));
    }
    to.iter()
        .map(|a| {
            a.trim()
                .parse::<Mailbox>()
                .map_err(|_| format!("{a:?} is not an email address"))
        })
        .collect()
}

const FOOTER: &str =
    "—\nSent by Haruspex camera alerts. Change where they go in Settings → Cameras → Alerts.";

/// The whole email. `pictures` are JPEG bytes with a file name each.
pub fn build(
    from: &str,
    to: &[Mailbox],
    alert: &CameraAlert,
    pictures: Vec<(String, Vec<u8>)>,
    message_id: &str,
    date: &str,
) -> Result<Message, String> {
    let from: Mailbox = from
        .trim()
        .parse()
        .map_err(|e| format!("From address {from:?} is not valid: {e}"))?;
    let mut b = Message::builder()
        .from(from)
        .subject(subject(alert, date))
        .date_now()
        .message_id(Some(format!("<{message_id}>")));
    for m in to {
        b = b.to(m.clone());
    }
    if let Some(parent) = alert.thread_id.as_deref().filter(|s| !s.is_empty()) {
        b = b.in_reply_to(format!("<{parent}>"));
        b = b.references(format!("<{parent}>"));
    }
    let mut text = alert.lines.join("\n");
    text.push_str("\n\n");
    text.push_str(FOOTER);
    let body = Body::new_with_encoding(text, ContentTransferEncoding::QuotedPrintable)
        .map_err(|_| "The alert's text could not be encoded".to_string())?;
    let text_part = SinglePart::builder()
        .header(ContentType::TEXT_PLAIN)
        .body(body);
    if pictures.is_empty() {
        return b
            .singlepart(text_part)
            .map_err(|e| format!("The alert could not be built: {e}"));
    }
    let jpeg = ContentType::parse("image/jpeg").map_err(|e| e.to_string())?;
    let mut parts = MultiPart::mixed().singlepart(text_part);
    for (name, data) in pictures.into_iter().take(MAX_ATTACHMENTS) {
        parts = parts.singlepart(Attachment::new(name).body(data, jpeg.clone()));
    }
    b.multipart(parts)
        .map_err(|e| format!("The alert could not be built: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alert(kind: CameraAlertKind) -> CameraAlert {
        CameraAlert {
            kind,
            camera_name: Some("Living room".into()),
            lines: vec!["03:10 — Someone is searching the drawers.".into()],
            event_ids: vec![],
            thread_id: None,
        }
    }

    #[test]
    fn the_subject_is_fixed_by_the_kind() {
        assert_eq!(
            subject(&alert(CameraAlertKind::Urgent), "2026-11-21"),
            "Haruspex: urgent — Living room"
        );
        assert_eq!(
            subject(&alert(CameraAlertKind::FollowUp), "x"),
            "Haruspex: urgent — Living room"
        );
        assert_eq!(
            subject(&alert(CameraAlertKind::Digest), "2026-11-21"),
            "Haruspex: camera digest — 2026-11-21"
        );
        assert_eq!(
            subject(&alert(CameraAlertKind::Paused), "x"),
            "Haruspex: camera alerts paused"
        );
        // A name can't add a header line.
        let mut a = alert(CameraAlertKind::Urgent);
        a.camera_name = Some("Hall\r\nBcc: x@evil.test".into());
        assert!(!subject(&a, "x").contains('\n'));
    }

    #[test]
    fn recipients_are_one_to_five_valid_addresses() {
        assert!(recipients(&[]).is_err());
        assert!(recipients(&["not an address".into()]).is_err());
        let six: Vec<String> = (0..6).map(|i| format!("a{i}@example.com")).collect();
        assert!(recipients(&six).is_err());
        assert_eq!(recipients(&six[..5]).unwrap().len(), 5);
    }

    #[test]
    fn pictures_are_attached_after_the_text() {
        let to = recipients(&["tim@example.com".into()]).unwrap();
        let msg = build(
            "home@example.com",
            &to,
            &alert(CameraAlertKind::Urgent),
            vec![("event-7.jpg".into(), vec![0xff, 0xd8, 0xff, 0xd9])],
            "abc.haruspex@example.com",
            "2026-11-21",
        )
        .unwrap();
        let raw = msg.formatted();
        let parsed = mail_parser::MessageParser::default().parse(&raw).unwrap();
        assert_eq!(parsed.subject(), Some("Haruspex: urgent — Living room"));
        let atts: Vec<_> = parsed.attachments().collect();
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0].attachment_name(), Some("event-7.jpg"));
        assert!(atts[0].is_content_type("image", "jpeg"));
        assert!(parsed
            .body_text(0)
            .unwrap()
            .contains("Someone is searching the drawers."));
    }

    #[test]
    fn a_follow_up_threads_under_the_first_alert() {
        let to = recipients(&["tim@example.com".into()]).unwrap();
        let mut a = alert(CameraAlertKind::FollowUp);
        a.thread_id = Some("first.haruspex@example.com".into());
        let raw = build(
            "home@example.com",
            &to,
            &a,
            vec![],
            "second@example.com",
            "x",
        )
        .unwrap()
        .formatted();
        let text = String::from_utf8_lossy(&raw);
        assert!(
            text.contains("In-Reply-To: <first.haruspex@example.com>"),
            "{text}"
        );
        assert!(
            text.contains("References: <first.haruspex@example.com>"),
            "{text}"
        );
    }
}
