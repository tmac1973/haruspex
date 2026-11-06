//! Settings → Remote control's commands: start and stop the owner API, and
//! add and revoke devices.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::clients::{OwnerClient, Scope};
use super::server;
use super::trust::{OwnerAccess, TrustedHost};
use super::{AppAudio, AppDispatch, AppImages, OwnerApi};
use crate::engine::{EngineHub, EVENT_ENABLED};
use crate::sync_util::LockExt;

/// What Settings → Remote control asks for.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OwnerApiConfig {
    pub enabled: bool,
    pub port: u16,
    /// Listen on every network, not just this computer.
    pub bind_all: bool,
    /// Who may connect without a token.
    #[serde(default)]
    pub access: OwnerAccess,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OwnerApiStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub bind_all: bool,
    /// Where another device reaches it: this computer's network address when
    /// listening on all networks, else loopback.
    pub address: Option<String>,
    /// This computer's name on the LAN, which also opens the web page.
    pub hostname: Option<String>,
    /// The HTTPS certificate's SHA-256, as a browser shows it, while running.
    pub fingerprint: Option<String>,
    /// The certificate itself (PEM), for a script to trust it.
    pub certificate: Option<String>,
}

/// A new device and its token, which is never shown again, with a one-time
/// code that pairs a browser with it (`/app/#pair=<code>`, for 10 minutes).
#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreatedOwnerClient {
    pub client: OwnerClient,
    pub token: String,
    pub pair_code: String,
}

/// Says whether the token and code are set, never what they are: either one
/// lets a browser in.
impl std::fmt::Debug for CreatedOwnerClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedOwnerClient")
            .field("client", &self.client)
            .field("token", &crate::text_util::redacted(&self.token))
            .field("pair_code", &crate::text_util::redacted(&self.pair_code))
            .finish()
    }
}

fn status(api: &OwnerApi) -> OwnerApiStatus {
    // Copied out first: one lock, released before the other is taken.
    let served = api.served.lock_or_recover().clone();
    let running = api.running.lock_or_recover();
    match running.as_ref() {
        Some(r) => OwnerApiStatus {
            running: true,
            fingerprint: served.as_ref().map(|s| s.0.clone()),
            certificate: served.map(|s| s.1),
            port: Some(r.port),
            bind_all: r.bind_all,
            hostname: super::trust::system_hostname(),
            address: Some(if r.bind_all {
                crate::remote::link::lan_address()
                    .map(|ip| ip.to_string())
                    .unwrap_or_else(|| "127.0.0.1".into())
            } else {
                "127.0.0.1".into()
            }),
        },
        None => OwnerApiStatus {
            running: false,
            port: None,
            bind_all: false,
            address: None,
            hostname: super::trust::system_hostname(),
            fingerprint: None,
            certificate: None,
        },
    }
}

/// Switch the engine to match the server, and tell every window if it changed.
fn set_engine(app: &AppHandle, on: bool) {
    if app.state::<EngineHub>().set_enabled(on) {
        let _ = app.emit(EVENT_ENABLED, app.state::<EngineHub>().enabled());
    }
}

/// Start, restart or stop the API to match `config`.
#[tauri::command]
pub async fn owner_api_apply(
    app: AppHandle,
    config: OwnerApiConfig,
) -> Result<OwnerApiStatus, String> {
    let api = app.state::<OwnerApi>();
    // Who may connect changes in place: no restart, nobody dropped.
    api.trust.set(config.access.clone());
    let identity = if config.enabled {
        let guest_chat = app.state::<crate::remote::RemoteServer>().trust().access();
        let extras: Vec<&str> = [&config.access.extra_host, &guest_chat.extra_host]
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect();
        Some(api.certificate(&extras)?)
    } else {
        None
    };
    {
        let running = api.running.lock_or_recover();
        if let Some(r) = running.as_ref() {
            let same_cert = identity.as_ref().map(|i| &i.fingerprint)
                == api.served.lock_or_recover().as_ref().map(|s| &s.0);
            if config.enabled && r.port == config.port && r.bind_all == config.bind_all && same_cert
            {
                drop(running);
                return Ok(status(&api));
            }
        }
    }
    // Taken out of the lock first: waiting for the port to come free can't
    // hold it.
    let previous = api.running.lock_or_recover().take();
    if let Some(r) = previous {
        r.shutdown().await;
    }
    let Some(identity) = identity else {
        *api.served.lock_or_recover() = None;
        if let Ok(clients) = api.clients() {
            clients.flush();
        }
        set_engine(&app, false);
        return Ok(status(&api));
    };
    let tls = super::tls::server_config(&identity)?;
    let services = server::Services {
        dispatch: Arc::new(AppDispatch(app.clone())),
        images: Arc::new(AppImages(app.clone())),
        audio: Arc::new(AppAudio(app.clone())),
        clients: api.clients()?,
        pairing: api.pairing.clone(),
        web_root: super::web_root(&app),
        trust: api.trust.clone(),
    };
    let running = server::start(services, config.port, config.bind_all, tls).await?;
    *api.running.lock_or_recover() = Some(running);
    *api.served.lock_or_recover() = Some((identity.fingerprint, identity.cert_pem));
    set_engine(&app, true);
    Ok(status(&api))
}

#[tauri::command]
pub fn owner_api_status(api: tauri::State<'_, OwnerApi>) -> OwnerApiStatus {
    status(&api)
}

#[tauri::command]
pub fn owner_clients_list(api: tauri::State<'_, OwnerApi>) -> Result<Vec<OwnerClient>, String> {
    Ok(api.clients()?.list())
}

#[tauri::command]
pub fn owner_client_create(
    api: tauri::State<'_, OwnerApi>,
    name: String,
    scopes: Vec<Scope>,
) -> Result<CreatedOwnerClient, String> {
    create_client(&api, &name, &scopes)
}

fn create_client(
    api: &OwnerApi,
    name: &str,
    scopes: &[Scope],
) -> Result<CreatedOwnerClient, String> {
    let (client, token) = api.clients()?.create(name, scopes)?;
    let pair_code = api.pairing.issue(&token)?;
    Ok(CreatedOwnerClient {
        client,
        token,
        pair_code,
    })
}

/// A new pairing link for a device. Its token can't be shown again, so this
/// gives it a new one: whatever used the old token must use the new one.
#[tauri::command]
pub fn owner_client_pair(
    api: tauri::State<'_, OwnerApi>,
    id: String,
) -> Result<CreatedOwnerClient, String> {
    pair_client(&api, &id)
}

fn pair_client(api: &OwnerApi, id: &str) -> Result<CreatedOwnerClient, String> {
    let (client, token) = api.clients()?.rotate(id)?;
    let pair_code = api.pairing.issue(&token)?;
    Ok(CreatedOwnerClient {
        client,
        token,
        pair_code,
    })
}

#[tauri::command]
pub fn owner_client_revoke(api: tauri::State<'_, OwnerApi>, id: String) -> Result<bool, String> {
    revoke_client(&api, &id)
}

fn revoke_client(api: &OwnerApi, id: &str) -> Result<bool, String> {
    api.clients()?.revoke(id)
}

/// The computers Settings lists as trusted, and where each was found.
#[tauri::command]
pub async fn owner_trusted_hosts(app: AppHandle) -> Vec<TrustedHost> {
    let trust = app.state::<OwnerApi>().trust.clone();
    trust.resolve_all().await
}

// `owner_api_apply` and the `#[tauri::command]` wrappers need a running Tauri
// app (`AppHandle`, `State`), which the tests can't build: they test what the
// commands call instead — `status`, the device functions, and the
// certificate whose fingerprint decides whether `owner_api_apply` restarts.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::owner::server::{Audio, BoxFuture, Dispatch, Images, StoredImage};
    use crate::test_util::{temp_dir, TestDir};
    use serde_json::Value;
    use std::path::PathBuf;
    use tokio::sync::broadcast;

    const NO_DEVICE_FOLDER: &str = "no app data folder for the device list";

    struct Nothing;

    impl Dispatch for Nothing {
        fn op(&self, _op: Value) -> BoxFuture<Result<Value, String>> {
            Box::pin(async { Err("no engine".into()) })
        }
        fn subscribe(&self) -> broadcast::Receiver<Value> {
            broadcast::channel(1).1
        }
    }

    impl Images for Nothing {
        fn lookup(&self, _urls: &[String]) -> Vec<(String, crate::db::ImageRow)> {
            Vec::new()
        }
        fn bytes(&self, _hash: &str) -> Option<(String, Vec<u8>)> {
            None
        }
        fn store(&self, _bytes: Vec<u8>) -> Result<StoredImage, String> {
            Err("no images".into())
        }
    }

    impl Audio for Nothing {
        fn file(&self, _hash: &str) -> Option<(String, PathBuf)> {
            None
        }
    }

    fn api_in(dir: &TestDir) -> OwnerApi {
        OwnerApi::load(Some(dir.to_path_buf()))
    }

    fn a_scope() -> [Scope; 1] {
        [Scope::ALL[0]]
    }

    #[test]
    fn a_stopped_api_reports_nothing_to_connect_to() {
        let s = status(&OwnerApi::load(None));
        assert!(!s.running);
        assert_eq!(s.port, None);
        assert!(!s.bind_all);
        assert_eq!(s.address, None);
        assert_eq!(s.fingerprint, None);
        assert_eq!(s.certificate, None);
    }

    #[test]
    fn a_certificate_left_from_a_stopped_server_is_not_reported() {
        let api = OwnerApi::load(None);
        *api.served.lock_or_recover() = Some(("AB:CD".into(), "PEM".into()));
        let s = status(&api);
        assert!(!s.running);
        assert_eq!(s.fingerprint, None);
        assert_eq!(s.certificate, None);
    }

    #[tokio::test]
    async fn a_running_api_reports_its_port_address_and_certificate() {
        let dir = temp_dir("owner_status");
        let api = api_in(&dir);
        let identity = api.certificate(&[]).unwrap();
        let services = server::Services {
            dispatch: Arc::new(Nothing),
            images: Arc::new(Nothing),
            audio: Arc::new(Nothing),
            clients: api.clients().unwrap(),
            pairing: api.pairing.clone(),
            web_root: None,
            trust: api.trust.clone(),
        };
        let tls = crate::owner::tls::server_config(&identity).unwrap();
        let running = server::start(services, 0, false, tls).await.unwrap();
        let port = running.port;
        *api.running.lock_or_recover() = Some(running);
        *api.served.lock_or_recover() =
            Some((identity.fingerprint.clone(), identity.cert_pem.clone()));

        let s = status(&api);
        assert!(s.running);
        assert_eq!(s.port, Some(port));
        assert!(!s.bind_all);
        assert_eq!(s.address.as_deref(), Some("127.0.0.1"));
        assert_eq!(s.fingerprint, Some(identity.fingerprint));
        assert_eq!(s.certificate, Some(identity.cert_pem));

        let r = api.running.lock_or_recover().take().unwrap();
        r.shutdown().await;
    }

    #[test]
    fn without_a_data_folder_there_is_no_certificate() {
        let err = OwnerApi::load(None).certificate(&[]).unwrap_err();
        assert!(err.contains("HTTPS certificate"), "{err}");
    }

    #[test]
    fn the_kept_certificate_is_reused_until_a_new_name_needs_one() {
        let dir = temp_dir("owner_cert");
        let api = api_in(&dir);
        let first = api.certificate(&[]).unwrap();
        // Same names: the same certificate, so `owner_api_apply` doesn't restart.
        assert_eq!(api.certificate(&[]).unwrap().fingerprint, first.fingerprint);
        // A link address it doesn't cover yet: a new one, so it does.
        let wider = api.certificate(&["haruspex.example.test"]).unwrap();
        assert_ne!(wider.fingerprint, first.fingerprint);
        assert!(wider.names.iter().any(|n| n == "haruspex.example.test"));
    }

    #[test]
    fn without_a_data_folder_every_device_command_says_why() {
        let api = OwnerApi::load(None);
        assert_eq!(
            create_client(&api, "Phone", &a_scope()).unwrap_err(),
            NO_DEVICE_FOLDER
        );
        assert_eq!(pair_client(&api, "abc").unwrap_err(), NO_DEVICE_FOLDER);
        assert_eq!(revoke_client(&api, "abc").unwrap_err(), NO_DEVICE_FOLDER);
    }

    #[test]
    fn an_unreadable_device_file_is_an_error_and_is_left_alone() {
        let dir = temp_dir("owner_bad_clients");
        let file = dir.join("owner-clients.json");
        std::fs::write(&file, b"{ not json").unwrap();
        let api = api_in(&dir);
        let err = create_client(&api, "Phone", &a_scope()).unwrap_err();
        assert!(err.contains("owner-clients.json"), "{err}");
        assert!(revoke_client(&api, "abc").is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"{ not json");
    }

    #[test]
    fn a_device_is_refused_without_a_name_or_a_permission() {
        let dir = temp_dir("owner_refuse");
        let api = api_in(&dir);
        assert!(create_client(&api, "  ", &a_scope()).is_err());
        assert!(create_client(&api, "Phone", &[]).is_err());
        assert!(api.clients().unwrap().list().is_empty());
    }

    #[test]
    fn a_new_device_gets_a_code_that_pairs_a_browser_with_its_token() {
        let dir = temp_dir("owner_create");
        let api = api_in(&dir);
        let made = create_client(&api, "Phone", &a_scope()).unwrap();
        assert_eq!(made.client.name, "Phone");
        assert_eq!(
            api.pairing.redeem(&made.pair_code),
            Some(made.token.clone())
        );
        let clients = api.clients().unwrap();
        assert_eq!(
            clients.authenticate(&made.token).map(|c| c.id),
            Some(made.client.id.clone())
        );
        // Kept on disk: a fresh load still knows it.
        assert_eq!(api_in(&dir).clients().unwrap().list().len(), 1);
    }

    #[test]
    fn pairing_again_replaces_the_token() {
        let dir = temp_dir("owner_pair");
        let api = api_in(&dir);
        let made = create_client(&api, "Phone", &a_scope()).unwrap();
        let again = pair_client(&api, &made.client.id).unwrap();
        assert_ne!(again.token, made.token);
        assert_eq!(
            api.pairing.redeem(&again.pair_code),
            Some(again.token.clone())
        );
        let clients = api.clients().unwrap();
        assert!(clients.authenticate(&made.token).is_none());
        assert!(clients.authenticate(&again.token).is_some());
    }

    #[test]
    fn pairing_an_unknown_device_is_an_error() {
        let dir = temp_dir("owner_pair_unknown");
        let api = api_in(&dir);
        assert_eq!(pair_client(&api, "nope").unwrap_err(), "no such device");
    }

    #[test]
    fn revoking_ends_the_token_and_says_whether_there_was_a_device() {
        let dir = temp_dir("owner_revoke");
        let api = api_in(&dir);
        let made = create_client(&api, "Phone", &a_scope()).unwrap();
        assert_eq!(revoke_client(&api, "nope"), Ok(false));
        assert_eq!(revoke_client(&api, &made.client.id), Ok(true));
        assert!(api.clients().unwrap().authenticate(&made.token).is_none());
        assert_eq!(revoke_client(&api, &made.client.id), Ok(false));
    }

    #[test]
    fn a_created_device_never_shows_its_token_in_a_log() {
        let dir = temp_dir("owner_debug");
        let api = api_in(&dir);
        let made = create_client(&api, "Phone", &a_scope()).unwrap();
        let shown = format!("{made:?}");
        assert!(!shown.contains(&made.token));
        assert!(!shown.contains(&made.pair_code));
    }
}
