//! TLS for talking to another Haruspex, whose certificate is self-signed
//! (`owner/tls.rs`). No CA vouches for it, so the owner compares its
//! SHA-256 fingerprint by eye once and this side pins it: the fingerprint is
//! the computer's identity, and names are not checked.
//!
//! - [`Capture`] accepts any certificate and records its fingerprint. Only a
//!   probe uses it, and a probe sends no credentials.
//! - [`Pinned`] accepts only the fingerprint it was given, and records a
//!   mismatch so the caller can say "certificate changed" rather than a TLS
//!   error.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, Error, SignatureScheme};

use crate::owner::tls::fingerprint;
use crate::sync_util::LockExt;

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// A client config that checks the server with `verifier`. HTTP/1.1, which is
/// all the owner API speaks; no SNI, as we connect by IP address.
pub fn client_config(
    verifier: Arc<dyn ServerCertVerifier>,
) -> Result<rustls::ClientConfig, String> {
    let mut config = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config.enable_sni = false;
    Ok(config)
}

/// The handshake's signature checks, which both verifiers still make: a
/// server must hold the key of the certificate it shows.
#[derive(Debug)]
struct Signatures(Arc<CryptoProvider>);

impl Signatures {
    fn new() -> Self {
        Signatures(provider())
    }

    fn tls12(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn tls13(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Accepts any certificate, keeping its fingerprint for the owner to check.
#[derive(Debug)]
pub struct Capture {
    seen: Mutex<Option<String>>,
    sig: Signatures,
}

impl Capture {
    pub fn new() -> Arc<Self> {
        Arc::new(Capture {
            seen: Mutex::new(None),
            sig: Signatures::new(),
        })
    }

    /// The fingerprint of the certificate the server showed, once it has.
    pub fn seen(&self) -> Option<String> {
        self.seen.lock_or_recover().clone()
    }
}

impl ServerCertVerifier for Capture {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        *self.seen.lock_or_recover() = Some(fingerprint(end_entity));
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.sig.tls12(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.sig.tls13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.sig.schemes()
    }
}

/// Accepts only the certificate whose fingerprint the owner confirmed.
#[derive(Debug)]
pub struct Pinned {
    pin: String,
    /// Set when a server showed another certificate.
    mismatch: Mutex<bool>,
    sig: Signatures,
}

impl Pinned {
    pub fn new(pin: &str) -> Arc<Self> {
        Arc::new(Pinned {
            pin: pin.trim().to_ascii_uppercase(),
            mismatch: Mutex::new(false),
            sig: Signatures::new(),
        })
    }

    /// Whether a server has shown a certificate other than the pinned one.
    pub fn mismatched(&self) -> bool {
        *self.mismatch.lock_or_recover()
    }
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        // Fingerprints aren't secret, so a plain comparison is fine.
        if fingerprint(end_entity) == self.pin {
            Ok(ServerCertVerified::assertion())
        } else {
            *self.mismatch.lock_or_recover() = true;
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.sig.tls12(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.sig.tls13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.sig.schemes()
    }
}
