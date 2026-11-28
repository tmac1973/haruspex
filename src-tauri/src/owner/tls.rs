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
    if let Some((kept, wrapped)) = std::fs::read(path).ok().and_then(from_disk) {
        if kept.fits(names, now) {
            if !wrapped {
                // Written before the key was wrapped on Windows: wrap it now.
                if let Err(e) = save(path, &kept) {
                    log::warn!("[owner] could not rewrite the HTTPS certificate: {e}");
                }
            }
            return Ok(kept);
        }
        log::info!("[owner] replacing the HTTPS certificate (expiring or new names)");
    }
    let made = generate(names, ips, OffsetDateTime::now_utc())?;
    save(path, &made)?;
    Ok(made)
}

/// The identity from what is on disk, and whether it was stored as [`save`]
/// writes it now. On Windows that is wrapped with DPAPI, so only this user's
/// login can read the private key; a plain file is from an older build.
fn from_disk(bytes: Vec<u8>) -> Option<(Identity, bool)> {
    if let Ok(plain) = serde_json::from_slice::<Identity>(&bytes) {
        return Some((plain, cfg!(not(windows))));
    }
    #[cfg(windows)]
    {
        let json = crate::secrets::dpapi::unprotect(&bytes).ok()?;
        serde_json::from_slice::<Identity>(&json)
            .ok()
            .map(|i| (i, true))
    }
    #[cfg(not(windows))]
    None
}

/// Kept readable by this user only: it holds the private key. Owner-only
/// mode on Unix; wrapped with DPAPI on Windows.
fn save(path: &Path, identity: &Identity) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(identity).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let json = crate::secrets::dpapi::protect(&json)?;
    crate::file_util::write_private_atomic(path, &json).map_err(|e| format!("could not save {e}"))
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
pub(crate) fn fingerprint(der: &[u8]) -> String {
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

/// The names to cover: this computer's, its `.local` one, the link addresses
/// Settings gives (Remote control's and Guest chat's), and `localhost`.
/// Addresses go in separately.
pub fn names_for(hostname: Option<&str>, extra_hosts: &[&str]) -> Vec<String> {
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
    for extra in extra_hosts.iter().filter_map(|e| host_of(e)) {
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
    use crate::test_util::{temp_dir, TestDir};

    /// A file in a fresh temp folder, which goes when the guard drops.
    fn tmp(name: &str) -> (TestDir, std::path::PathBuf) {
        let dir = temp_dir(&format!("owner_tls_{name}"));
        let path = dir.join("tls.json");
        (dir, path)
    }

    #[test]
    fn names_cover_this_computer_and_the_link_address() {
        assert_eq!(
            names_for(
                Some("Asmodean"),
                &["https://box.lan:8788", "asmodean.example.internal"]
            ),
            [
                "asmodean",
                "asmodean.local",
                "box.lan",
                "asmodean.example.internal",
                "localhost"
            ]
        );
        // An address is not a name, and nothing is listed twice.
        assert_eq!(
            names_for(Some("box.lan"), &["192.168.1.9"]),
            ["box.lan", "localhost"]
        );
        assert_eq!(names_for(None, &[]), ["localhost"]);
    }

    #[test]
    fn a_new_certificate_serves_and_shows_its_fingerprint() {
        let id = generate(
            &names_for(Some("box"), &[]),
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
        let (_dir, path) = tmp("keep");
        let names = names_for(Some("box"), &[]);
        let first = load_or_create(&path, &names, &[]).unwrap();
        // Restarting keeps it, so browsers keep the owner's answer.
        let again = load_or_create(&path, &names, &[]).unwrap();
        assert_eq!(first.fingerprint, again.fingerprint);
        // A new address doesn't replace it either.
        let moved = load_or_create(&path, &names, &["10.0.0.4".parse().unwrap()]).unwrap();
        assert_eq!(first.fingerprint, moved.fingerprint);
        // A new link address does.
        let renamed = load_or_create(&path, &names_for(Some("box"), &["box.lan"]), &[]).unwrap();
        assert_ne!(first.fingerprint, renamed.fingerprint);
        // So does one near its end.
        let mut old = renamed.clone();
        old.not_after = OffsetDateTime::now_utc().unix_timestamp() + 86_400;
        save(&path, &old).unwrap();
        let renewed = load_or_create(&path, &names_for(Some("box"), &["box.lan"]), &[]).unwrap();
        assert_ne!(renewed.fingerprint, renamed.fingerprint);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "the key file is private");
        }
    }

    #[test]
    fn an_unreadable_file_is_replaced() {
        let (_dir, path) = tmp("junk");
        std::fs::write(&path, b"not json").unwrap();
        assert!(load_or_create(&path, &names_for(Some("box"), &[]), &[]).is_ok());
    }

    #[test]
    fn what_is_saved_loads_back_as_saved_now() {
        let (_dir, path) = tmp("roundtrip");
        let names = names_for(Some("box"), &[]);
        let made = load_or_create(&path, &names, &[]).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        // Wrapped on Windows, so the private key is not there in the clear.
        assert_eq!(
            serde_json::from_slice::<Identity>(&bytes).is_ok(),
            cfg!(not(windows))
        );
        let (back, current) = from_disk(bytes).unwrap();
        assert!(current);
        assert_eq!(back.fingerprint, made.fingerprint);
    }

    #[test]
    fn a_plain_file_from_an_older_build_is_kept() {
        let (_dir, path) = tmp("plain");
        let names = names_for(Some("box"), &[]);
        let made = load_or_create(&path, &names, &[]).unwrap();
        std::fs::write(&path, serde_json::to_vec(&made).unwrap()).unwrap();
        let again = load_or_create(&path, &names, &[]).unwrap();
        assert_eq!(again.fingerprint, made.fingerprint);
        let (_, current) = from_disk(std::fs::read(&path).unwrap()).unwrap();
        assert!(current);
    }
}
