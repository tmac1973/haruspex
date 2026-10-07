//! "Sign in with Google" for calendars and contacts.
//!
//! Google's data takes an OAuth bearer token instead of a password. Calendars
//! come from its Calendar API (`google_calendar.rs`) and contacts from its
//! People API (`google_contacts.rs`), both read-only. Haruspex registers one desktop OAuth client for everyone, so a
//! user's whole setup is a browser consent screen — no Cloud project of their
//! own. The flow is the installed-app one Google documents: a loopback
//! redirect to a port we listen on, PKCE, and a refresh token kept in the
//! secret store where a server account's password would be.
//!
//! The client comes from `google-oauth.json` at build time (see `build.rs`).
//! A build without it offers no Google sign-in rather than a broken one.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::proxy::{apply_proxy, ProxyConfig};
use crate::sync_util::LockExt;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";

/// Read-only calendars, read-only contacts, and who signed in.
const SCOPES: &str = "openid email \
    https://www.googleapis.com/auth/calendar.readonly \
    https://www.googleapis.com/auth/contacts.readonly";
const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";
const CONTACTS_SCOPE: &str = "https://www.googleapis.com/auth/contacts.readonly";

/// Where calendar discovery starts for a Google account. Google serves no
/// `.well-known/caldav`, but this path answers the principal query, so the
/// usual principal → home-set ladder runs from here.
pub const CALDAV_BASE: &str = "https://apidata.googleusercontent.com/caldav/v2";

/// How long the browser consent may take before the sign-in gives up.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

struct Client {
    id: &'static str,
    secret: &'static str,
}

fn client() -> Option<Client> {
    Some(Client {
        id: option_env!("HARUSPEX_GOOGLE_CLIENT_ID")?,
        secret: option_env!("HARUSPEX_GOOGLE_CLIENT_SECRET")?,
    })
}

/// What a finished sign-in hands back.
pub struct Grant {
    pub email: String,
    pub refresh_token: String,
    pub calendars: bool,
    pub contacts: bool,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    error_description: Option<String>,
}

/// Run the consent flow: open the browser, wait for Google to redirect back,
/// and trade the code for a refresh token.
pub async fn sign_in(proxy: Option<&ProxyConfig>) -> Result<Grant, String> {
    let client = client().ok_or("This build of Haruspex has no Google sign-in.")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not listen for Google's answer: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not listen for Google's answer: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let verifier = random_token(48)?;
    let state = random_token(24)?;
    let url = consent_url(client.id, &redirect_uri, &challenge(&verifier), &state);
    crate::links::open_in_browser(&url)?;

    let code = tokio::time::timeout(CONSENT_TIMEOUT, receive_code(&listener, &state))
        .await
        .map_err(|_| "Google sign-in timed out. Try again.".to_string())??;

    let response = http(proxy)?
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form(&[
            ("code", code.as_str()),
            ("client_id", client.id),
            ("client_secret", client.secret),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ]))
        .send()
        .await
        .map_err(|e| format!("Could not reach Google: {}", e.without_url()))?;
    let tokens = read_tokens(response).await?;

    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or("Google did not grant lasting access. Try signing in again.")?;
    let email = tokens
        .id_token
        .as_deref()
        .and_then(email_from_id_token)
        .ok_or("Google did not say which account signed in.")?;
    let granted = tokens.scope.as_deref().unwrap_or_default();
    let grant = Grant {
        email,
        calendars: has_scope(granted, CALENDAR_SCOPE),
        contacts: has_scope(granted, CONTACTS_SCOPE),
        refresh_token,
    };
    if !grant.calendars && !grant.contacts {
        return Err(
            "Google signed in without calendar or contacts access. Sign in again and tick both boxes."
                .into(),
        );
    }
    cache_token(&grant.refresh_token, &tokens);
    Ok(grant)
}

/// A current access token for a stored refresh token, refreshed when the
/// cached one is about to lapse.
pub async fn access_token(
    refresh_token: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<String, String> {
    if let Some(token) = cached_token(refresh_token) {
        return Ok(token);
    }
    let client = client().ok_or("This build of Haruspex has no Google sign-in.")?;
    let response = http(proxy)?
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form(&[
            ("refresh_token", refresh_token),
            ("client_id", client.id),
            ("client_secret", client.secret),
            ("grant_type", "refresh_token"),
        ]))
        .send()
        .await
        .map_err(|e| format!("Could not reach Google: {}", e.without_url()))?;
    let tokens = read_tokens(response).await?;
    cache_token(refresh_token, &tokens);
    Ok(tokens.access_token)
}

/// Tell Google to forget a refresh token. Best effort: the token is deleted
/// locally either way, and an already-revoked one is not an error.
pub async fn revoke(refresh_token: &str, proxy: Option<&ProxyConfig>) {
    cache().lock_or_recover().remove(refresh_token);
    if let Ok(http) = http(proxy) {
        let _ = http
            .post(REVOKE_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form(&[("token", refresh_token)]))
            .send()
            .await;
    }
}

fn consent_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    let mut url = url::Url::parse(AUTH_URL).expect("the auth URL is valid");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair(
            "scope",
            &SCOPES.split_whitespace().collect::<Vec<_>>().join(" "),
        )
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        // A refresh token, every time: without `prompt=consent` Google gives
        // one only on the first grant, and a re-sign-in would come back empty.
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    url.into()
}

/// Wait for the browser to come back with `?code=…&state=…`.
///
/// Anything else that reaches the port — a favicon request, a stray probe —
/// is answered and ignored, so it cannot end the sign-in.
async fn receive_code(listener: &tokio::net::TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|e| format!("Lost Google's answer: {e}"))?;
        let mut buf = vec![0u8; 8192];
        let n = socket.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/");
        let outcome = parse_redirect(target, state);
        let page = match &outcome {
            Some(Ok(_)) => "Signed in. You can close this tab and go back to Haruspex.",
            Some(Err(_)) => {
                "Sign-in did not finish. You can close this tab and try again in Haruspex."
            }
            None => "",
        };
        let body = format!(
            "<!doctype html><meta charset=utf-8><title>Haruspex</title>\
             <p style=\"font:16px system-ui;margin:3em\">{page}</p>"
        );
        let reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(reply.as_bytes()).await;
        if let Some(result) = outcome {
            return result;
        }
    }
}

/// The code from a redirect target, `None` when it is not the redirect at all.
fn parse_redirect(target: &str, state: &str) -> Option<Result<String, String>> {
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    if params.get("state").map(String::as_str) != Some(state) {
        return None;
    }
    if let Some(error) = params.get("error") {
        return Some(Err(if error == "access_denied" {
            "Google sign-in was cancelled.".into()
        } else {
            format!("Google sign-in failed: {error}")
        }));
    }
    params.get("code").cloned().map(Ok)
}

async fn read_tokens(response: reqwest::Response) -> Result<TokenResponse, String> {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        return serde_json::from_str(&text)
            .map_err(|_| "Google's token answer could not be read.".to_string());
    }
    let error: Option<TokenError> = serde_json::from_str(&text).ok();
    Err(match error {
        Some(e) if e.error == "invalid_grant" => "Google access has expired or was removed. \
             Sign in again in Settings → Integrations → Calendar & Contacts."
            .into(),
        Some(e) => format!(
            "Google refused the sign-in: {}",
            e.error_description.unwrap_or(e.error)
        ),
        None => format!("Google answered HTTP {}.", status.as_u16()),
    })
}

/// An `application/x-www-form-urlencoded` body.
fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

fn has_scope(granted: &str, scope: &str) -> bool {
    granted.split_whitespace().any(|s| s == scope)
}

/// The `email` claim of an ID token. Not verified: the token came straight
/// from Google's token endpoint over TLS, and it only labels the account.
fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("email")?.as_str().map(str::to_string)
}

/// PKCE's S256 challenge for a verifier.
fn challenge(verifier: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest.as_ref())
}

/// `bytes` of OS randomness, URL-safe.
fn random_token(bytes: usize) -> Result<String, String> {
    use ring::rand::SecureRandom;
    let mut buf = vec![0u8; bytes];
    ring::rand::SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| "Could not get randomness for the sign-in.".to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

fn http(proxy: Option<&ProxyConfig>) -> Result<reqwest::Client, String> {
    apply_proxy(reqwest::Client::builder().timeout(REQUEST_TIMEOUT), proxy)?
        .build()
        .map_err(|e| format!("could not create an HTTP client: {e}"))
}

/// Access tokens by refresh token, in memory only. An hour each; refreshed a
/// minute early so a request never goes out with one about to lapse.
fn cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cache_token(refresh_token: &str, tokens: &TokenResponse) {
    let life = Duration::from_secs(tokens.expires_in.unwrap_or(3600).saturating_sub(60));
    cache().lock_or_recover().insert(
        refresh_token.to_string(),
        (tokens.access_token.clone(), Instant::now() + life),
    );
}

fn cached_token(refresh_token: &str) -> Option<String> {
    let cache = cache().lock_or_recover();
    let (token, expires) = cache.get(refresh_token)?;
    (Instant::now() < *expires).then(|| token.clone())
}

/// What the settings card needs after a sign-in. The refresh token itself
/// stays in Rust: it goes to the secret store, and only its key comes back —
/// unless no store works on this machine, the one case it is returned inline,
/// as a password would be.
#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSignIn {
    pub email: String,
    pub password: String,
    pub password_ref: Option<String>,
    pub has_calendars: bool,
    pub has_contacts: bool,
}

/// Whether this build can sign in to Google at all.
#[tauri::command]
pub fn google_sign_in_available() -> bool {
    client().is_some()
}

/// Sign a calendar account in to Google and keep its refresh token.
#[tauri::command]
pub async fn google_sign_in(
    account_id: String,
    proxy: Option<ProxyConfig>,
) -> Result<GoogleSignIn, String> {
    let grant = sign_in(proxy.as_ref()).await?;
    let key = super::account::secret_key(&account_id);
    let (password, password_ref) = if crate::secrets::secret_available().await {
        crate::secrets::secret_set(key.clone(), grant.refresh_token.clone()).await?;
        (String::new(), Some(key))
    } else {
        (grant.refresh_token.clone(), None)
    };
    Ok(GoogleSignIn {
        email: grant.email,
        password,
        password_ref,
        has_calendars: grant.calendars,
        has_contacts: grant.contacts,
    })
}

/// Revoke a Google account's access when it is removed.
#[tauri::command]
pub async fn google_sign_out(
    account: super::account::DavAccount,
    proxy: Option<ProxyConfig>,
) -> Result<(), String> {
    if let Ok(resolved) = account.stored_secret().await {
        revoke(&resolved, proxy.as_ref()).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_consent_url_asks_for_offline_read_access_with_pkce() {
        let url = consent_url("id.apps", "http://127.0.0.1:5000", "chal", "st");
        let parsed = url::Url::parse(&url).unwrap();
        let q: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5000");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["prompt"], "consent");
        assert!(q["scope"].contains(CALENDAR_SCOPE));
        assert!(q["scope"].contains(CONTACTS_SCOPE));
        assert!(
            !q["scope"].contains("auth/calendar "),
            "read-only calendar only"
        );
    }

    #[test]
    fn the_pkce_challenge_matches_the_rfc_example() {
        // RFC 7636, Appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn only_the_redirect_with_our_state_ends_the_wait() {
        assert_eq!(parse_redirect("/favicon.ico", "st"), None);
        assert_eq!(parse_redirect("/?code=abc&state=other", "st"), None);
        assert_eq!(
            parse_redirect("/?code=abc&state=st&scope=x", "st"),
            Some(Ok("abc".into()))
        );
        assert!(parse_redirect("/?error=access_denied&state=st", "st")
            .unwrap()
            .unwrap_err()
            .contains("cancelled"));
    }

    #[test]
    fn the_email_comes_from_the_id_token() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"email":"me@gmail.com","email_verified":true}"#);
        assert_eq!(
            email_from_id_token(&format!("h.{payload}.s")).as_deref(),
            Some("me@gmail.com")
        );
        assert_eq!(email_from_id_token("garbage"), None);
    }

    #[test]
    fn granted_scopes_are_matched_whole() {
        let granted = format!("openid {CALENDAR_SCOPE} email");
        assert!(has_scope(&granted, CALENDAR_SCOPE));
        assert!(!has_scope(&granted, CONTACTS_SCOPE));
    }

    #[test]
    fn a_cached_token_is_used_until_just_before_it_lapses() {
        let tokens = TokenResponse {
            access_token: "at".into(),
            expires_in: Some(3600),
            refresh_token: None,
            id_token: None,
            scope: None,
        };
        cache_token("rt-fresh", &tokens);
        assert_eq!(cached_token("rt-fresh").as_deref(), Some("at"));
        let lapsing = TokenResponse {
            expires_in: Some(30),
            ..tokens
        };
        cache_token("rt-lapsing", &lapsing);
        assert_eq!(cached_token("rt-lapsing"), None);
    }

    /// Sign in for real and run discovery against Google's DAV hosts. Opens a
    /// browser; the refresh token is kept in `HARUSPEX_GOOGLE_TOKEN_FILE` so a
    /// rerun skips the consent screen. Ignored by default: it needs a person.
    #[tokio::test]
    #[ignore]
    async fn live_google_sign_in_and_discovery() {
        use super::super::account::{DavAccount, DavKind};

        let file = std::env::var("HARUSPEX_GOOGLE_TOKEN_FILE").expect("HARUSPEX_GOOGLE_TOKEN_FILE");
        let refresh = match std::fs::read_to_string(&file) {
            Ok(t) => t.trim().to_string(),
            Err(_) => {
                let grant = sign_in(None).await.expect("sign-in");
                println!(
                    "signed in as {} (calendars {}, contacts {})",
                    grant.email, grant.calendars, grant.contacts
                );
                std::fs::write(&file, &grant.refresh_token).unwrap();
                grant.refresh_token
            }
        };
        let account = DavAccount {
            id: "live".into(),
            kind: Some(DavKind::Google),
            label: "Google".into(),
            enabled: true,
            address: std::env::var("HARUSPEX_GOOGLE_EMAIL").unwrap_or_default(),
            username: String::new(),
            password: refresh,
            password_ref: None,
            calendar_url: None,
            contacts_url: None,
            has_calendars: None,
            has_contacts: None,
        };
        let commands = super::super::commands::dav_list_events(
            vec![account.clone()],
            None,
            None,
            None,
            Some("UTC".into()),
            None,
        )
        .await
        .expect("events");
        let mut per_calendar = std::collections::BTreeMap::<String, usize>::new();
        for event in &commands.events {
            *per_calendar
                .entry(event.calendar_name.len().to_string())
                .or_default() += 1;
        }
        println!(
            "events in the default window: {} across {} calendars; problems: {:?}",
            commands.events.len(),
            per_calendar.len(),
            commands.problems
        );
        let contacts =
            super::super::commands::dav_search_contacts(vec![account], String::new(), None)
                .await
                .expect("contacts");
        println!(
            "contacts: {} (showing {}); problems: {:?}",
            contacts.total_matched,
            contacts.contacts.len(),
            contacts.problems
        );
    }
}
