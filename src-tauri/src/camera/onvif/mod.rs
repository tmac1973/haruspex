//! A small ONVIF client: enough of the device, media and PTZ services to find
//! a camera's streams and aim it. Hand-rolled over `reqwest` and `quick-xml`;
//! the ONVIF crates pull in a code-generated WSDL layer far larger than the
//! dozen calls used here.
//!
//! Every call goes straight to the camera, never through the proxy, with a
//! 5-second timeout. Requests carry a WS-Security UsernameToken (password
//! digest, timed by the camera's own clock); a camera that answers 401 gets
//! the request again with HTTP digest auth. Errors pass through
//! [`Credentials::redact`] before they leave.

pub mod discovery;
pub(crate) mod ptz;
pub(crate) mod soap;

use super::{Credentials, OnvifPreset};
use serde::{Deserialize, Serialize};
use soap::Element;
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(5);

/// What `camera_onvif_connect` found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct OnvifConnection {
    /// The highest-resolution stream, without credentials.
    pub main_url: String,
    /// The lowest-resolution stream; the main one when there is only one.
    pub sub_url: String,
    /// The profile pan/tilt and presets go through.
    pub profile_token: String,
    pub has_ptz: bool,
    pub presets: Vec<OnvifPreset>,
}

/// One media profile, as `GetProfiles` describes it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Profile {
    pub token: String,
    pub name: String,
    /// `H264`, `H265`, `JPEG`…; empty without a video encoder.
    pub encoding: String,
    pub width: u32,
    pub height: u32,
    pub has_ptz: bool,
}

/// The service addresses `GetCapabilities` gives.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Services {
    pub media: Option<String>,
    pub ptz: Option<String>,
}

/// A camera's device service and the credentials to call it with.
pub(crate) struct Client {
    device_url: String,
    creds: Credentials,
    /// The camera's clock minus ours, for the token's `Created`.
    clock_offset: chrono::TimeDelta,
}

impl Client {
    /// A client for the device service at `xaddr`, its clock read so the
    /// tokens it signs are on time by the camera's clock.
    pub async fn new(xaddr: &str, creds: Credentials) -> Result<Self, String> {
        let url = url::Url::parse(xaddr.trim())
            .map_err(|_| format!("{xaddr} isn't an ONVIF address."))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!("{xaddr} isn't an ONVIF address."));
        }
        let mut client = Self {
            device_url: url.to_string(),
            creds,
            clock_offset: chrono::TimeDelta::zero(),
        };
        // Unauthenticated, and optional: a camera that won't say keeps ours.
        if let Ok(reply) = client
            .send(&client.device_url, "<tds:GetSystemDateAndTime/>", false)
            .await
        {
            if let Some(theirs) = parse_system_time(&reply) {
                client.clock_offset = theirs - chrono::Utc::now();
            }
        }
        Ok(client)
    }

    pub fn device_url(&self) -> &str {
        &self.device_url
    }

    /// Call `url` with `body` (one request element), signed. Returns the
    /// response element inside the SOAP body.
    pub async fn call(&self, url: &str, body: &str) -> Result<Element, String> {
        self.send(url, body, true)
            .await
            .map_err(|e| self.creds.redact(&e))
    }

    async fn send(&self, url: &str, body: &str, sign: bool) -> Result<Element, String> {
        let signed = sign && !self.creds.username.is_empty();
        let token = signed.then(|| self.token());
        let xml = soap::envelope(body, token.as_ref());
        let http = client_for(url);
        let request = |xml: String| {
            http.post(url)
                .header("Content-Type", "application/soap+xml; charset=utf-8")
                .body(xml)
        };
        let mut response = request(xml)
            .send()
            .await
            .map_err(|e| unreachable(url, &e))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && signed {
            let challenge = response
                .headers()
                .get_all(reqwest::header::WWW_AUTHENTICATE)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .find(|v| v.trim_start().to_ascii_lowercase().starts_with("digest"))
                .map(str::to_string);
            if let Some(auth) = challenge.and_then(|c| self.http_digest(&c, url)) {
                response = request(soap::envelope(body, None))
                    .header(reqwest::header::AUTHORIZATION, auth)
                    .send()
                    .await
                    .map_err(|e| unreachable(url, &e))?;
            }
        }
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("The camera's reply was cut off: {e}"))?;
        let root = soap::parse(&text).ok();
        if let Some(reason) = root.as_ref().and_then(soap::fault) {
            return Err(describe_fault(&reason, status));
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("The camera refused the user name or password.".into());
        }
        if !status.is_success() {
            return Err(format!("The camera answered {status}."));
        }
        let root = root.ok_or("The camera's reply isn't ONVIF.")?;
        soap::body(&root)
            .cloned()
            .ok_or_else(|| "The camera's reply is empty.".into())
    }

    fn token(&self) -> soap::UsernameToken {
        let nonce = uuid::Uuid::new_v4();
        let created = (chrono::Utc::now() + self.clock_offset)
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        soap::UsernameToken::new(
            &self.creds.username,
            &self.creds.password,
            nonce.as_bytes(),
            &created,
        )
    }

    fn http_digest(&self, challenge: &str, url: &str) -> Option<String> {
        let parsed = url::Url::parse(url).ok()?;
        let uri = match parsed.query() {
            Some(q) => format!("{}?{q}", parsed.path()),
            None => parsed.path().to_string(),
        };
        let cnonce = crate::hash_util::hex(uuid::Uuid::new_v4().as_bytes());
        soap::digest_authorization(
            challenge,
            "POST",
            &uri,
            &self.creds.username,
            &self.creds.password,
            &cnonce,
        )
    }

    /// The media and PTZ service addresses.
    pub async fn services(&self) -> Result<Services, String> {
        let reply = self
            .call(
                &self.device_url,
                "<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>",
            )
            .await?;
        Ok(parse_capabilities(&reply))
    }
}

/// One shared client per TLS policy. Never proxied: cameras are on the LAN.
fn client_for(url: &str) -> &'static reqwest::Client {
    static STRICT: OnceLock<reqwest::Client> = OnceLock::new();
    static LENIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let build = |lenient: bool| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(TIMEOUT)
            .danger_accept_invalid_certs(lenient)
            .build()
            .expect("a client with no proxy and a timeout builds")
    };
    if lenient_tls(url) {
        LENIENT.get_or_init(|| build(true))
    } else {
        STRICT.get_or_init(|| build(false))
    }
}

/// An `https` address on the local network, where cameras' certificates are
/// self-signed as a rule. A name is never trusted this way, only an address.
fn lenient_tls(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    let ip = match u.host() {
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
        _ => return false,
    };
    u.scheme() == "https" && crate::net_util::is_non_public(ip)
}

fn unreachable(url: &str, e: &reqwest::Error) -> String {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string());
    if e.is_timeout() {
        format!("{host} didn't answer within 5 seconds.")
    } else {
        format!("Couldn't reach {host}: {e}")
    }
}

fn describe_fault(reason: &str, status: reqwest::StatusCode) -> String {
    let lower = reason.to_ascii_lowercase();
    if status == reqwest::StatusCode::UNAUTHORIZED
        || lower.contains("not authorized")
        || lower.contains("notauthorized")
        || lower.contains("authority failure")
    {
        "The camera refused the user name or password.".into()
    } else {
        format!("The camera refused: {reason}")
    }
}

/// Find the camera's streams, the profile to aim it through and its presets.
pub(crate) async fn connect(xaddr: &str, creds: Credentials) -> Result<OnvifConnection, String> {
    let client = Client::new(xaddr, creds).await?;
    let services = client.services().await?;
    // A camera that lists no media service usually serves it at the device
    // address.
    let media = services.media.clone().unwrap_or(client.device_url.clone());
    let reply = client.call(&media, "<trt:GetProfiles/>").await?;
    let profiles = parse_profiles(&reply);
    let picked = pick_profiles(&profiles).ok_or("The camera has no video profiles.")?;
    let main_url = stream_uri(&client, &media, &picked.main.token).await?;
    let sub_url = if picked.sub.token == picked.main.token {
        main_url.clone()
    } else {
        stream_uri(&client, &media, &picked.sub.token).await?
    };
    let has_ptz = services.ptz.is_some() && picked.ptz.is_some();
    let profile_token = picked.ptz.unwrap_or(picked.main).token.clone();
    let presets = match services.ptz.as_deref() {
        Some(ptz_url) if has_ptz => ptz::presets_at(&client, ptz_url, &profile_token)
            .await
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    Ok(OnvifConnection {
        main_url,
        sub_url,
        profile_token,
        has_ptz,
        presets,
    })
}

async fn stream_uri(client: &Client, media: &str, token: &str) -> Result<String, String> {
    let body = format!(
        concat!(
            "<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>",
            "<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>",
            "<trt:ProfileToken>{}</trt:ProfileToken></trt:GetStreamUri>"
        ),
        soap::escape(token)
    );
    let reply = client.call(media, &body).await?;
    let uri = reply
        .text_at(&["MediaUri", "Uri"])
        .ok_or("The camera gave no stream address.")?;
    Ok(clean_stream_uri(uri, client.device_url()))
}

/// A stream address as it should be stored: no `user:pass@` (some cameras
/// write their credentials into it), and the device's own host when the
/// camera names an address nobody else can reach (`0.0.0.0`, loopback).
pub(crate) fn clean_stream_uri(uri: &str, device_url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(uri.trim()) else {
        return uri.trim().to_string();
    };
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    // `rtsp:` isn't a special scheme to `url`, so its host is opaque text.
    let unusable = match parsed.host_str().map(|h| h.trim_matches(['[', ']'])) {
        Some(h) => {
            h.eq_ignore_ascii_case("localhost")
                || h.parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_unspecified() || ip.is_loopback())
        }
        None => true,
    };
    if unusable {
        if let Some(host) = url::Url::parse(device_url)
            .ok()
            .and_then(|d| d.host_str().map(str::to_string))
        {
            let _ = parsed.set_host(Some(&host));
        }
    }
    parsed.to_string()
}

pub(crate) fn parse_system_time(reply: &Element) -> Option<chrono::DateTime<chrono::Utc>> {
    use chrono::TimeZone;
    let utc = reply.find("UTCDateTime")?;
    let n = |path: &[&str]| -> Option<u32> { utc.text_at(path)?.parse().ok() };
    let year = utc.text_at(&["Date", "Year"])?.parse().ok()?;
    chrono::Utc
        .with_ymd_and_hms(
            year,
            n(&["Date", "Month"])?,
            n(&["Date", "Day"])?,
            n(&["Time", "Hour"])?,
            n(&["Time", "Minute"])?,
            n(&["Time", "Second"])?,
        )
        .single()
}

pub(crate) fn parse_capabilities(reply: &Element) -> Services {
    let caps = reply.find("Capabilities");
    let xaddr = |service: &str| {
        caps.and_then(|c| c.child(service))
            .and_then(|s| s.text_at(&["XAddr"]))
            .map(str::to_string)
    };
    Services {
        media: xaddr("Media"),
        ptz: xaddr("PTZ"),
    }
}

pub(crate) fn parse_profiles(reply: &Element) -> Vec<Profile> {
    reply
        .children_named("Profiles")
        .filter_map(|p| {
            let token = p.attr("token")?.to_string();
            let encoder = p.child("VideoEncoderConfiguration");
            let dim = |name: &str| -> u32 {
                encoder
                    .and_then(|e| e.text_at(&["Resolution", name]))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0)
            };
            Some(Profile {
                name: p.text_at(&["Name"]).unwrap_or(&token).to_string(),
                encoding: encoder
                    .and_then(|e| e.text_at(&["Encoding"]))
                    .unwrap_or("")
                    .to_string(),
                width: dim("Width"),
                height: dim("Height"),
                has_ptz: p.child("PTZConfiguration").is_some(),
                token,
            })
        })
        .collect()
}

/// Which profiles a camera's streams and pan/tilt come from.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Picked<'a> {
    pub main: &'a Profile,
    pub sub: &'a Profile,
    /// The profile to aim through: the main one when it has a PTZ
    /// configuration, else the first that does.
    pub ptz: Option<&'a Profile>,
}

/// The main stream is the highest-resolution profile and the sub stream the
/// lowest, H.264 winning a tie (any other codec ffmpeg decodes will do).
/// Profiles without video (audio or metadata only) are passed over.
pub(crate) fn pick_profiles(profiles: &[Profile]) -> Option<Picked<'_>> {
    let video: Vec<&Profile> = profiles.iter().filter(|p| !p.encoding.is_empty()).collect();
    let candidates = if video.is_empty() {
        profiles.iter().collect()
    } else {
        video
    };
    let area = |p: &Profile| u64::from(p.width) * u64::from(p.height);
    let h264 = |p: &Profile| p.encoding.eq_ignore_ascii_case("H264");
    // `max_by_key`/`min_by_key` keep the last/first of equals; the order
    // the camera lists them in breaks a full tie.
    let main = *candidates.iter().rev().max_by_key(|p| (area(p), h264(p)))?;
    let sub = *candidates.iter().min_by_key(|p| (area(p), !h264(p)))?;
    let ptz = if main.has_ptz {
        Some(main)
    } else {
        profiles.iter().find(|p| p.has_ptz)
    };
    Some(Picked { main, sub, ptz })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Element {
        let xml = match name {
            "thingino_capabilities" => include_str!("fixtures/thingino_get_capabilities.xml"),
            "thingino_profiles" => include_str!("fixtures/thingino_get_profiles.xml"),
            "thingino_stream_uri" => include_str!("fixtures/thingino_get_stream_uri.xml"),
            "thingino_time" => include_str!("fixtures/thingino_get_system_date_and_time.xml"),
            "generic_capabilities" => include_str!("fixtures/generic_get_capabilities.xml"),
            "generic_profiles" => include_str!("fixtures/generic_get_profiles.xml"),
            "generic_stream_uri" => include_str!("fixtures/generic_get_stream_uri.xml"),
            _ => unreachable!("{name}"),
        };
        soap::body(&soap::parse(xml).unwrap()).unwrap().clone()
    }

    #[test]
    fn thingino_capabilities_list_media_and_ptz() {
        let s = parse_capabilities(&fixture("thingino_capabilities"));
        assert_eq!(
            s.media.as_deref(),
            Some("http://192.168.1.184/onvif/media_service")
        );
        assert_eq!(
            s.ptz.as_deref(),
            Some("http://192.168.1.184/onvif/ptz_service")
        );
    }

    #[test]
    fn generic_capabilities_without_ptz() {
        let s = parse_capabilities(&fixture("generic_capabilities"));
        assert_eq!(s.media.as_deref(), Some("http://192.168.1.64/onvif/Media"));
        assert_eq!(s.ptz, None);
    }

    #[test]
    fn thingino_main_is_ch0_and_sub_is_ch1() {
        let profiles = parse_profiles(&fixture("thingino_profiles"));
        assert_eq!(profiles.len(), 2);
        let picked = pick_profiles(&profiles).unwrap();
        assert_eq!(picked.main.token, "Profile_0");
        assert_eq!((picked.main.width, picked.main.height), (1920, 1080));
        assert_eq!(picked.sub.token, "Profile_1");
        assert_eq!(picked.ptz.map(|p| p.token.as_str()), Some("Profile_0"));
        let uri = fixture("thingino_stream_uri");
        assert_eq!(
            clean_stream_uri(
                uri.text_at(&["MediaUri", "Uri"]).unwrap(),
                "http://192.168.1.184/onvif/device_service"
            ),
            "rtsp://192.168.1.184:554/ch0"
        );
    }

    #[test]
    fn generic_profiles_prefer_h264_and_skip_audio_only() {
        let profiles = parse_profiles(&fixture("generic_profiles"));
        assert_eq!(profiles.len(), 4);
        let picked = pick_profiles(&profiles).unwrap();
        // 2688×1520 in both H.265 and H.264: H.264 wins the tie.
        assert_eq!(picked.main.token, "Profile_101");
        assert_eq!(picked.main.encoding, "H264");
        assert_eq!(picked.sub.token, "Profile_102");
        assert_eq!(picked.ptz, None);
    }

    #[test]
    fn one_profile_is_both_streams() {
        let only = Profile {
            token: "p".into(),
            encoding: "JPEG".into(),
            width: 640,
            height: 480,
            ..Profile::default()
        };
        let list = [only];
        let picked = pick_profiles(&list).unwrap();
        assert_eq!(picked.main, picked.sub);
        assert!(pick_profiles(&[]).is_none());
    }

    #[test]
    fn stream_uris_lose_their_credentials_and_bogus_hosts() {
        let device = "http://192.168.1.64/onvif/device_service";
        let uri = fixture("generic_stream_uri");
        assert_eq!(
            clean_stream_uri(uri.text_at(&["MediaUri", "Uri"]).unwrap(), device),
            "rtsp://192.168.1.64:554/Streaming/Channels/101?transportmode=unicast&profile=Profile_101"
        );
        assert_eq!(
            clean_stream_uri("rtsp://0.0.0.0:8554/live", device),
            "rtsp://192.168.1.64:8554/live"
        );
        assert_eq!(clean_stream_uri("not a url", device), "not a url");
    }

    #[test]
    fn the_camera_clock_is_read() {
        // Recorded from a Thingino D1, unauthenticated.
        let t = parse_system_time(&fixture("thingino_time")).unwrap();
        assert_eq!(t.to_rfc3339(), "2026-11-12T21:50:05+00:00");
    }

    #[test]
    fn only_lan_https_skips_certificate_checks() {
        assert!(lenient_tls("https://192.168.1.10/onvif/device_service"));
        assert!(!lenient_tls("http://192.168.1.10/onvif/device_service"));
        assert!(!lenient_tls("https://8.8.8.8/onvif/device_service"));
        assert!(!lenient_tls("https://camera.local/onvif/device_service"));
    }

    #[test]
    fn faults_read_as_plain_errors() {
        let refused = describe_fault("Sender not authorized", reqwest::StatusCode::BAD_REQUEST);
        assert_eq!(refused, "The camera refused the user name or password.");
        let other = describe_fault("No such profile", reqwest::StatusCode::BAD_REQUEST);
        assert_eq!(other, "The camera refused: No such profile");
    }

    /// A pretend Thingino camera on loopback. It wants HTTP digest auth for
    /// everything but the clock, as some cameras do, and answers each request
    /// from the fixtures by what it asks for. Returns its address and every
    /// request it saw.
    async fn fake_camera() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (log, host) = (seen.clone(), base.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                // Headers, then as much body as Content-Length says.
                let request = loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break String::from_utf8_lossy(&buf).into_owned();
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end]
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length")
                                    .then(|| v.trim().parse::<usize>().ok())?
                            })
                            .unwrap_or(0);
                        if buf.len() >= end + 4 + len {
                            break text;
                        }
                    }
                };
                log.lock().unwrap().push(request.clone());
                let authed = request.contains("Authorization: Digest")
                    || request.contains("authorization: Digest");
                let fixture = if request.contains("GetSystemDateAndTime") {
                    Some(include_str!(
                        "fixtures/thingino_get_system_date_and_time.xml"
                    ))
                } else if !authed {
                    None
                } else if request.contains("GetCapabilities") {
                    Some(include_str!("fixtures/thingino_get_capabilities.xml"))
                } else if request.contains("GetProfiles") {
                    Some(include_str!("fixtures/thingino_get_profiles.xml"))
                } else if request.contains("GetStreamUri") {
                    Some(include_str!("fixtures/thingino_get_stream_uri.xml"))
                } else if request.contains("GetPresets") {
                    Some(include_str!("fixtures/thingino_get_presets.xml"))
                } else {
                    Some(include_str!("fixtures/fault_not_authorized.xml"))
                };
                let reply = match fixture {
                    Some(xml) => {
                        let mut xml = xml.replace("http://192.168.1.184", &host);
                        if request.contains("Profile_1") {
                            xml = xml.replace("/ch0", "/ch1");
                        }
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/soap+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{xml}",
                            xml.len()
                        )
                    }
                    None => "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"thingino\", qop=\"auth\", nonce=\"abc\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                };
                let _ = sock.write_all(reply.as_bytes()).await;
            }
        });
        (base, seen)
    }

    #[tokio::test]
    async fn connect_falls_back_to_http_digest_and_finds_everything() {
        let (base, seen) = fake_camera().await;
        let creds = Credentials {
            username: "root".into(),
            password: "s3cret!".into(),
        };
        let found = connect(&format!("{base}/onvif/device_service"), creds)
            .await
            .unwrap();
        assert_eq!(found.main_url, "rtsp://192.168.1.184:554/ch0");
        assert_eq!(found.sub_url, "rtsp://192.168.1.184:554/ch1");
        assert_eq!(found.profile_token, "Profile_0");
        assert!(found.has_ptz);
        assert_eq!(found.presets.len(), 2);
        let seen = seen.lock().unwrap();
        // The signed attempt carried a token, never the password itself.
        assert!(seen.iter().any(|r| r.contains("PasswordDigest")));
        assert!(seen.iter().all(|r| !r.contains("s3cret!")));
        // The retry with digest auth drops the WS-Security header.
        assert!(seen
            .iter()
            .filter(|r| r.to_ascii_lowercase().contains("authorization: digest"))
            .all(|r| !r.contains("UsernameToken")));
    }

    #[tokio::test]
    async fn a_refusal_is_plain_and_redacted() {
        let (base, _) = fake_camera().await;
        let creds = Credentials {
            username: "root".into(),
            password: "s3cret!".into(),
        };
        let client = Client::new(&format!("{base}/onvif/device_service"), creds)
            .await
            .unwrap();
        let err = client
            .call(client.device_url(), "<tds:GetDeviceInformation/>")
            .await
            .unwrap_err();
        assert_eq!(err, "The camera refused the user name or password.");
    }
}
