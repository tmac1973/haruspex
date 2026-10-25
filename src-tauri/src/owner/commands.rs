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
        Some(api.certificate(config.access.extra_host.as_deref())?)
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
    let (client, token) = api.clients()?.create(&name, &scopes)?;
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
    let (client, token) = api.clients()?.rotate(&id)?;
    let pair_code = api.pairing.issue(&token)?;
    Ok(CreatedOwnerClient {
        client,
        token,
        pair_code,
    })
}

#[tauri::command]
pub fn owner_client_revoke(api: tauri::State<'_, OwnerApi>, id: String) -> Result<bool, String> {
    api.clients()?.revoke(&id)
}

/// The computers Settings lists as trusted, and where each was found.
#[tauri::command]
pub async fn owner_trusted_hosts(app: AppHandle) -> Vec<TrustedHost> {
    let trust = app.state::<OwnerApi>().trust.clone();
    trust.resolve_all().await
}
