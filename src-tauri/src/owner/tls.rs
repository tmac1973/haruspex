//! The certificate Settings → Remote control serves HTTPS with.
//!
//! A computer on a home network can't get a certificate a browser trusts on
//! its own: public authorities only sign names someone owns. So Haruspex makes
//! its own, once, and keeps it. Each browser warns the first time and
//! remembers the owner's answer, which holds only while the certificate stays
//! the same; so it is replaced only when it nears its end or this computer's
//! names change, not when an address does (a DHCP lease). Settings shows its
//! fingerprint, so the owner can check the one the browser shows.

use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;

use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose, SanType,
};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};

/// How long a certificate lasts: under the 398 days browsers accept from a
/// public authority, which some apply to every certificate.
const LIFETIME_DAYS: i64 = 397;

/// A certificate this close to its end is replaced at the next start.
const RENEW_DAYS: i64 = 30;

/// The certificate and its key, as kept in the app data folder.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Identity {
    pub cert_pem: String,
    pub key_pem: String,
    /// The DNS names it covers; a name added since means a new one.
    pub names: Vec<String>,
    /// Unix seconds.
    pub not_after: i64,
    /// SHA-256 of the certificate, as browsers show it (`AB:CD:…`).
    pub fingerprint: String,
}

impl Identity {
    /// Still good for `names` at `now`, with time to spare.
    fn fits(&self, names: &[String], now: i64) -> bool {
        self.not_after - now > RENEW_DAYS * 86_400
            && names
                .iter()
                .all(|n| self.names.iter().any(|m| m.eq_ignore_ascii_case(n)))
    }
}

/// The certificate in `path`, or a new one there when it is missing,
/// unreadable, near its end, or doesn't cover `names`.
pub fn load_or_create(path: &Path, names: &[String], ips: &[IpAddr]) -> Result<Identity, String> {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    if let Some(kept) = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Identity>(&b).ok())
    {
        if kept.fits(names, now) {
            return Ok(kept);
        }
        log::info!("[owner] replacing the HTTPS certificate (expiring or new names)");
    }
    let made = generate(names, ips, OffsetDateTime::now_utc())?;
    save(path, &made)?;
    Ok(made)
}

/// Kept readable by this user only: it holds the private key.
fn save(path: &Path, identity: &Identity) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(identity).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    }
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options
            .open(&tmp)
            .map_err(|e| format!("could not write {tmp:?}: {e}"))?;
        f.write_all(&json).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("could not save {path:?}: {e}"))
}

/// A new certificate for `names` and `ips`, valid from a day before `now`
/// (a clock a little behind still accepts it).
pub fn generate(names: &[String], ips: &[IpAddr], now: OffsetDateTime) -> Result<Identity, String> {
    let key = KeyPair::generate().map_err(|e| format!("could not make a key: {e}"))?;
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    let label = names.first().map(String::as_str).unwrap_or("this computer");
    dn.push(DnType::CommonName, format!("Haruspex on {label}"));
    dn.push(DnType::OrganizationName, "Haruspex");
    params.distinguished_name = dn;
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = now - Duration::days(1);
    params.not_after = now + Duration::days(LIFETIME_DAYS);
    for name in names {
        let ia5 = name
            .clone()
            .try_into()
            .map_err(|e| format!("{name:?} can't go in a certificate: {e}"))?;
        params.subject_alt_names.push(SanType::DnsName(ia5));
    }
    for ip in ips {
        params.subject_alt_names.push(SanType::IpAddress(*ip));
    }
    let not_after = params.not_after.unix_timestamp();
    let cert = params
        .self_signed(&key)
        .map_err(|e| format!("could not make the certificate: {e}"))?;
    Ok(Identity {
        fingerprint: fingerprint(cert.der()),
        cert_pem: cert.pem(),
        key_pem: key.serialize_pem(),
        names: names.to_vec(),
        not_after,
    })
}

/// `AB:CD:…`, upper case, as Chrome and Firefox show a certificate's SHA-256.
fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// What the server answers TLS with. HTTP/1.1 only: that's all it speaks.
pub fn server_config(identity: &Identity) -> Result<Arc<rustls::ServerConfig>, String> {
    let certs = CertificateDer::pem_slice_iter(identity.cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("the saved certificate is unreadable: {e}"))?;
    let key = PrivateKeyDer::from_pem_slice(identity.key_pem.as_bytes())
        .map_err(|e| format!("the saved key is unreadable: {e}"))?;
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_no_client_auth()
    .with_single_cert(certs, key)
    .map_err(|e| format!("the certificate and key don't fit: {e}"))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// The names to cover: this computer's, its `.local` one, the link address
/// Settings gives, and `localhost`. Addresses go in separately.
pub fn names_for(hostname: Option<&str>, extra_host: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |n: &str| {
        let n = n.trim().trim_end_matches('.').to_ascii_lowercase();
        if !n.is_empty() && n.parse::<IpAddr>().is_err() && !out.contains(&n) {
            out.push(n);
        }
    };
    if let Some(h) = hostname {
        add(h);
        if !h.contains('.') {
            add(&format!("{h}.local"));
        }
    }
    if let Some(extra) = extra_host.and_then(host_of) {
        add(&extra);
    }
    add("localhost");
    out
}

/// The host in a link address: `box.lan` from `https://box.lan:8788/x`.
fn host_of(address: &str) -> Option<String> {
    let rest = address.split_once("://").map(|(_, r)| r).unwrap_or(address);
    let authority = rest.split('/').next()?;
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next()?
    } else {
        authority.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("owner-tls-{name}-{}.json", std::process::id()))
    }

    #[test]
    fn names_cover_this_computer_and_the_link_address() {
        assert_eq!(
            names_for(Some("Asmodean"), Some("https://box.lan:8788")),
            ["asmodean", "asmodean.local", "box.lan", "localhost"]
        );
        // An address is not a name, and nothing is listed twice.
        assert_eq!(
            names_for(Some("box.lan"), Some("192.168.1.9")),
            ["box.lan", "localhost"]
        );
        assert_eq!(names_for(None, None), ["localhost"]);
    }

    #[test]
    fn a_new_certificate_serves_and_shows_its_fingerprint() {
        let id = generate(
            &names_for(Some("box"), None),
            &["192.168.1.9".parse().unwrap()],
            OffsetDateTime::now_utc(),
        )
        .unwrap();
        assert!(server_config(&id).is_ok());
        assert_eq!(id.fingerprint.len(), 32 * 3 - 1);
        assert!(id.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
    }

    #[test]
    fn it_is_kept_until_it_nears_its_end_or_a_name_is_new() {
        let path = tmp("keep");
        let _ = std::fs::remove_file(&path);
        let names = names_for(Some("box"), None);
        let first = load_or_create(&path, &names, &[]).unwrap();
        // Restarting keeps it, so browsers keep the owner's answer.
        let again = load_or_create(&path, &names, &[]).unwrap();
        assert_eq!(first.fingerprint, again.fingerprint);
        // A new address doesn't replace it either.
        let moved = load_or_create(&path, &names, &["10.0.0.4".parse().unwrap()]).unwrap();
        assert_eq!(first.fingerprint, moved.fingerprint);
        // A new link address does.
        let renamed = load_or_create(&path, &names_for(Some("box"), Some("box.lan")), &[]).unwrap();
        assert_ne!(first.fingerprint, renamed.fingerprint);
        // So does one near its end.
        let mut old = renamed.clone();
        old.not_after = OffsetDateTime::now_utc().unix_timestamp() + 86_400;
        save(&path, &old).unwrap();
        let renewed = load_or_create(&path, &names_for(Some("box"), Some("box.lan")), &[]).unwrap();
        assert_ne!(renewed.fingerprint, renamed.fingerprint);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "the key file is private");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_unreadable_file_is_replaced() {
        let path = tmp("junk");
        std::fs::write(&path, b"not json").unwrap();
        assert!(load_or_create(&path, &names_for(Some("box"), None), &[]).is_ok());
        let _ = std::fs::remove_file(&path);
    }
}
