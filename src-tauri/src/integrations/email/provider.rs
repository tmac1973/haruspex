//! Built-in email provider presets.
//!
//! Each preset captures everything we need to connect to a specific
//! well-known provider without asking the user for more than their
//! address and an app password. The `Custom` variant lets the user type
//! their own hostnames for anything we don't ship a preset for.

use serde::{Deserialize, Serialize};

/// Transport security mode for an IMAP or SMTP connection.
///
/// `Implicit` means the socket is wrapped in TLS from the start
/// (classic port 993 / port 465 behavior). `StartTls` means we connect
/// plain and upgrade via the protocol's STARTTLS command (port 143 /
/// port 587). All our built-in presets use `Implicit` because every
/// major provider we target supports it and it avoids a downgrade
/// window, but custom hosts can pick either.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TlsMode {
    #[default]
    Implicit,
    Starttls,
}

/// Which provider family an account is configured for. The id is used
/// as the serialized tag so we can roundtrip it cleanly through the
/// frontend settings blob.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmailProvider {
    Gmail,
    Fastmail,
    Icloud,
    Yahoo,
    Custom,
}

/// A built-in preset with default hostnames + docs URL for one
/// provider. The `Custom` provider has no preset — the frontend uses
/// the `custom` variant to let the user type their own hosts.
#[derive(Clone, Debug, Serialize)]
pub struct EmailProviderPreset {
    /// Stable machine id: matches the lowercased enum variant.
    pub id: &'static str,
    /// Human-facing label shown in the dropdown.
    pub label: &'static str,
    pub imap_host: &'static str,
    pub imap_port: u16,
    pub imap_tls: TlsMode,
    pub smtp_host: &'static str,
    pub smtp_port: u16,
    pub smtp_tls: TlsMode,
    /// URL to the provider's app-password documentation, shown inline
    /// in the credential form so the user can jump straight to the
    /// page that lets them generate one.
    pub app_password_url: &'static str,
    /// Whether the provider requires 2FA to be enabled before app
    /// passwords can be generated. All our presets are `true` in 2026.
    pub requires_2fa: bool,
}

/// Full preset list exposed to the frontend via the
/// `email_list_providers` Tauri command.
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
    EmailProviderPreset {
        id: "fastmail",
        label: "Fastmail",
        imap_host: "imap.fastmail.com",
        imap_port: 993,
        imap_tls: TlsMode::Implicit,
        smtp_host: "smtp.fastmail.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Implicit,
        app_password_url: "https://app.fastmail.com/settings/security/tokens",
        requires_2fa: true,
    },
    EmailProviderPreset {
        id: "icloud",
        label: "iCloud Mail",
        imap_host: "imap.mail.me.com",
        imap_port: 993,
        imap_tls: TlsMode::Implicit,
        smtp_host: "smtp.mail.me.com",
        smtp_port: 587,
        smtp_tls: TlsMode::Starttls,
        app_password_url: "https://account.apple.com/account/manage",
        requires_2fa: true,
    },
    EmailProviderPreset {
        id: "yahoo",
        label: "Yahoo Mail",
        imap_host: "imap.mail.yahoo.com",
        imap_port: 993,
        imap_tls: TlsMode::Implicit,
        smtp_host: "smtp.mail.yahoo.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Implicit,
        app_password_url: "https://login.yahoo.com/account/security",
        requires_2fa: true,
    },
];

/// Look up a preset by its id string. Returns `None` for `"custom"`
/// (no preset) or any unknown value. Unused by the current command
/// surface (the frontend looks presets up itself from the list
/// `email_list_providers` returns), kept for future backend code
/// that wants to validate user-facing provider strings.
#[allow(dead_code)]
pub fn preset_by_id(id: &str) -> Option<&'static EmailProviderPreset> {
    PRESETS.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_presets_have_distinct_ids() {
        let mut seen: Vec<&str> = Vec::new();
        for p in PRESETS {
            assert!(!seen.contains(&p.id), "duplicate preset id: {}", p.id);
            seen.push(p.id);
        }
    }

    #[test]
    fn preset_by_id_roundtrips() {
        for p in PRESETS {
            let looked_up = preset_by_id(p.id).expect("preset lookup failed");
            assert_eq!(looked_up.label, p.label);
        }
        assert!(preset_by_id("custom").is_none());
        assert!(preset_by_id("nope").is_none());
    }

    #[test]
    fn well_known_hostnames() {
        // Sanity check: if someone accidentally breaks a preset,
        // catch it before a user stares at a TLS handshake error.
        let gmail = preset_by_id("gmail").unwrap();
        assert_eq!(gmail.imap_host, "imap.gmail.com");
        assert_eq!(gmail.imap_port, 993);

        let fastmail = preset_by_id("fastmail").unwrap();
        assert_eq!(fastmail.imap_host, "imap.fastmail.com");
    }
}
