//! One-time pairing codes: how a browser gets a device's token without
//! anyone typing 68 characters on a phone.
//!
//! Adding a device in Settings → Remote control issues a code, shown as a
//! link and a QR code. The web client sends it to `POST /api/v1/pair` and
//! gets the token back as an `HttpOnly` cookie. A code works once, for
//! [`CODE_LIFETIME`], and lives only in memory: an app restart forgets it.
//! The link carries it in the URL fragment, which browsers never send to a
//! server, so it stays out of logs. A code for a device revoked meanwhile
//! still redeems, but for a token that no longer authenticates.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ring::rand::{SecureRandom, SystemRandom};

use crate::sync_util::LockExt;

pub const CODE_LIFETIME: Duration = Duration::from_secs(10 * 60);

struct Pending {
    token: String,
    expires: Instant,
}

#[derive(Default)]
pub struct PairingCodes {
    codes: Mutex<HashMap<String, Pending>>,
}

impl PairingCodes {
    /// A code that redeems for `token` once, within [`CODE_LIFETIME`].
    pub fn issue(&self, token: &str) -> Result<String, String> {
        self.issue_for(token, CODE_LIFETIME)
    }

    fn issue_for(&self, token: &str, lifetime: Duration) -> Result<String, String> {
        let mut bytes = [0u8; 24];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| "the system random number generator failed".to_string())?;
        let code: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let mut codes = self.codes.lock_or_recover();
        codes.retain(|_, p| p.expires > Instant::now());
        codes.insert(
            code.clone(),
            Pending {
                token: token.to_string(),
                expires: Instant::now() + lifetime,
            },
        );
        Ok(code)
    }

    /// The token a code stands for, once. A used or expired code is `None`.
    pub fn redeem(&self, code: &str) -> Option<String> {
        let mut codes = self.codes.lock_or_recover();
        let pending = codes.remove(code.trim())?;
        (pending.expires > Instant::now()).then_some(pending.token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_works_once() {
        let codes = PairingCodes::default();
        let code = codes.issue("hsx_t").unwrap();
        assert_eq!(code.len(), 48);
        assert_eq!(codes.redeem(&code).as_deref(), Some("hsx_t"));
        assert_eq!(codes.redeem(&code), None);
    }

    #[test]
    fn an_expired_code_does_not() {
        let codes = PairingCodes::default();
        let code = codes.issue_for("hsx_t", Duration::ZERO).unwrap();
        assert_eq!(codes.redeem(&code), None);
    }

    #[test]
    fn a_made_up_code_does_not() {
        let codes = PairingCodes::default();
        codes.issue("hsx_t").unwrap();
        assert_eq!(codes.redeem("00"), None);
    }
}
