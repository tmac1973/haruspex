//! WS-Discovery: a multicast `Probe` for ONVIF video transmitters, sent out of
//! every IPv4 interface but loopback, and the `ProbeMatch` replies cameras
//! send back to it.
//!
//! Nothing here goes through the proxy: it is UDP on the local network.

use super::soap::{self, Element};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;
use tokio::net::UdpSocket;

const MULTICAST: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const PORT: u16 = 3702;

/// How long replies are collected for.
pub(crate) const PROBE_WAIT: Duration = Duration::from_secs(3);

/// A camera that answered the probe.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredCamera {
    /// Its ONVIF device service.
    pub xaddr: String,
    /// The name it gives itself; empty when it gives none.
    pub name: String,
    /// Its model, when it says.
    pub hardware: String,
    /// The name its address is known by on the network, which follows it
    /// when the router gives it a new address; empty when it has none.
    pub hostname: String,
}

/// One `ProbeMatch`, as sent.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProbeMatch {
    /// The device's endpoint reference, normally `urn:uuid:…`.
    pub endpoint: String,
    pub xaddrs: Vec<String>,
    pub scopes: Vec<String>,
}

/// Probe the network and list the cameras that answer within `wait`, one
/// entry per device.
pub async fn discover(wait: Duration) -> Result<Vec<DiscoveredCamera>, String> {
    let message_id = format!("uuid:{}", uuid::Uuid::new_v4());
    let probe = probe_message(&message_id);
    let sockets = interface_sockets()?;
    let deadline = tokio::time::Instant::now() + wait;
    let tasks: Vec<_> = sockets
        .into_iter()
        .map(|socket| {
            let probe = probe.clone();
            tokio::spawn(async move { collect(socket, probe, deadline).await })
        })
        .collect();
    let mut packets = Vec::new();
    for task in tasks {
        if let Ok(mut got) = task.await {
            packets.append(&mut got);
        }
    }
    let mut cameras = cameras_from(&packets);
    add_hostnames(&mut cameras).await;
    Ok(cameras)
}

/// Fill in each camera's network name, looked up all at once.
async fn add_hostnames(cameras: &mut [DiscoveredCamera]) {
    let mut lookups = tokio::task::JoinSet::new();
    for (i, camera) in cameras.iter().enumerate() {
        let Some(ip) = url::Url::parse(&camera.xaddr)
            .ok()
            .and_then(|u| u.host_str().and_then(|h| h.parse::<IpAddr>().ok()))
        else {
            continue;
        };
        lookups.spawn(async move { (i, super::hostname::name_for(ip).await) });
    }
    while let Some(done) = lookups.join_next().await {
        if let Ok((i, Some(name))) = done {
            cameras[i].hostname = name;
        }
    }
}

/// A socket bound to each IPv4 interface that isn't loopback, its multicast
/// sent out of that interface.
fn interface_sockets() -> Result<Vec<UdpSocket>, String> {
    let interfaces =
        if_addrs::get_if_addrs().map_err(|e| format!("Couldn't list network interfaces: {e}"))?;
    let mut sockets = Vec::new();
    let mut last_error = None;
    for iface in interfaces {
        let IpAddr::V4(ip) = iface.ip() else { continue };
        if ip.is_loopback() {
            continue;
        }
        match bind(ip) {
            Ok(s) => sockets.push(s),
            Err(e) => last_error = Some(format!("{}: {e}", iface.name)),
        }
    }
    if sockets.is_empty() {
        return Err(match last_error {
            Some(e) => format!("Couldn't search the network ({e})."),
            None => "Not connected to a network.".into(),
        });
    }
    Ok(sockets)
}

fn bind(ip: Ipv4Addr) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.bind(&SocketAddr::V4(SocketAddrV4::new(ip, 0)).into())?;
    socket.set_multicast_if_v4(&ip)?;
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket.into())
}

/// Send the probe (twice, as WS-Discovery advises over UDP) and gather
/// replies until `deadline`, with the address each came from.
async fn collect(
    socket: UdpSocket,
    probe: String,
    deadline: tokio::time::Instant,
) -> Vec<(String, IpAddr)> {
    let target = SocketAddr::V4(SocketAddrV4::new(MULTICAST, PORT));
    if socket.send_to(probe.as_bytes(), target).await.is_err() {
        return Vec::new();
    }
    let mut resend = Some(tokio::time::Instant::now() + Duration::from_millis(300));
    let mut out = Vec::new();
    let mut buf = vec![0u8; 65_536];
    loop {
        let until = resend.map_or(deadline, |r| r.min(deadline));
        match tokio::time::timeout_at(until, socket.recv_from(&mut buf)).await {
            Ok(Ok((n, from))) => {
                out.push((String::from_utf8_lossy(&buf[..n]).into_owned(), from.ip()));
            }
            Ok(Err(_)) => {}
            Err(_) if resend.is_some() && until < deadline => {
                resend = None;
                let _ = socket.send_to(probe.as_bytes(), target).await;
            }
            Err(_) => break,
        }
    }
    out
}

pub(crate) fn probe_message(message_id: &str) -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" "#,
            r#"xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" "#,
            r#"xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" "#,
            r#"xmlns:dn="http://www.onvif.org/ver10/network/wsdl">"#,
            "<e:Header><w:MessageID>{id}</w:MessageID>",
            r#"<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>"#,
            r#"<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>"#,
            "</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types>",
            "</d:Probe></e:Body></e:Envelope>"
        ),
        id = soap::escape(message_id)
    )
}

/// The `ProbeMatch`es in one reply; none when it isn't one.
pub(crate) fn parse_probe_matches(xml: &str) -> Vec<ProbeMatch> {
    let Ok(root) = soap::parse(xml) else {
        return Vec::new();
    };
    let Some(matches) = root.find("ProbeMatches") else {
        return Vec::new();
    };
    let words = |el: &Element, name: &str| -> Vec<String> {
        el.child(name)
            .map(|e| e.text.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default()
    };
    matches
        .children_named("ProbeMatch")
        .map(|m| ProbeMatch {
            endpoint: m
                .path(&["EndpointReference", "Address"])
                .map(|a| a.text.trim().to_string())
                .unwrap_or_default(),
            xaddrs: words(m, "XAddrs"),
            scopes: words(m, "Scopes"),
        })
        .collect()
}

/// The cameras in a set of replies, one per device: a device answers once per
/// interface it hears the probe on, and once per probe.
pub(crate) fn cameras_from(packets: &[(String, IpAddr)]) -> Vec<DiscoveredCamera> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (xml, from) in packets {
        for m in parse_probe_matches(xml) {
            let Some(xaddr) = pick_xaddr(&m.xaddrs, *from) else {
                continue;
            };
            let key = if m.endpoint.is_empty() {
                xaddr.clone()
            } else {
                m.endpoint.to_ascii_lowercase()
            };
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            out.push(DiscoveredCamera {
                name: scope(&m.scopes, "name").unwrap_or_default(),
                hardware: scope(&m.scopes, "hardware").unwrap_or_default(),
                xaddr,
                hostname: String::new(),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.xaddr.cmp(&b.xaddr)));
    out
}

/// The address to call the device on: the one on the address the reply came
/// from, else the first IPv4 one, else the first. A camera with a second
/// network (a Docker bridge, a dead Wi-Fi link) lists it too.
fn pick_xaddr(xaddrs: &[String], from: IpAddr) -> Option<String> {
    let parsed: Vec<(String, url::Url)> = xaddrs
        .iter()
        .filter_map(|x| url::Url::parse(x).ok().map(|u| (x.clone(), u)))
        .filter(|(_, u)| matches!(u.scheme(), "http" | "https"))
        .collect();
    let host_ip = |u: &url::Url| match u.host() {
        Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        _ => None,
    };
    parsed
        .iter()
        .find(|(_, u)| host_ip(u) == Some(from))
        .or_else(|| {
            parsed
                .iter()
                .find(|(_, u)| matches!(host_ip(u), Some(IpAddr::V4(_))))
        })
        .or_else(|| parsed.first())
        .map(|(x, _)| x.clone())
}

/// The value of an `onvif://www.onvif.org/<kind>/<value>` scope, decoded.
fn scope(scopes: &[String], kind: &str) -> Option<String> {
    let prefix = format!("onvif://www.onvif.org/{kind}/");
    scopes.iter().find_map(|s| {
        let rest = s.strip_prefix(&prefix)?;
        let decoded = urlencoding::decode(rest)
            .map(|d| d.into_owned())
            .unwrap_or_else(|_| rest.to_string());
        let value = decoded.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn the_probe_asks_for_video_transmitters() {
        let xml = probe_message("uuid:1234");
        let root = soap::parse(&xml).unwrap();
        assert_eq!(root.text_at(&["Header", "MessageID"]), Some("uuid:1234"));
        assert_eq!(
            root.find("Types").map(|t| t.text.as_str()),
            Some("dn:NetworkVideoTransmitter")
        );
    }

    #[test]
    fn a_thingino_reply_names_the_camera() {
        let xml = include_str!("fixtures/thingino_probe_match.xml");
        let matches = parse_probe_matches(xml);
        assert_eq!(matches.len(), 1);
        let cams = cameras_from(&[(xml.to_string(), ip("192.168.1.184"))]);
        assert_eq!(cams.len(), 1);
        assert_eq!(
            cams[0],
            DiscoveredCamera {
                xaddr: "http://192.168.1.184/onvif/device_service".into(),
                name: "Thingino".into(),
                hardware: "Cinnado_D1".into(),
                hostname: String::new(),
            }
        );
        // An empty `location/` scope is no value.
        assert_eq!(scope(&matches[0].scopes, "location"), None);
    }

    #[test]
    fn a_generic_reply_picks_the_address_it_came_from() {
        let xml = include_str!("fixtures/generic_probe_match.xml");
        let cams = cameras_from(&[(xml.to_string(), ip("192.168.1.64"))]);
        assert_eq!(
            cams,
            vec![DiscoveredCamera {
                xaddr: "http://192.168.1.64/onvif/device_service".into(),
                name: "Front Door".into(),
                hardware: "DS-2CD2043G2-I".into(),
                hostname: String::new(),
            }]
        );
        // Heard from an address it doesn't list: the first IPv4 one.
        let other = cameras_from(&[(xml.to_string(), ip("10.0.0.9"))]);
        assert_eq!(other[0].xaddr, "http://172.17.0.1/onvif/device_service");
    }

    #[test]
    fn replies_are_deduplicated_by_device() {
        let thingino = include_str!("fixtures/thingino_probe_match.xml").to_string();
        let generic = include_str!("fixtures/generic_probe_match.xml").to_string();
        let packets = vec![
            (thingino.clone(), ip("192.168.1.184")),
            (generic.clone(), ip("192.168.1.64")),
            (thingino.clone(), ip("192.168.1.184")),
            (generic, ip("192.168.1.64")),
            ("not xml at all".into(), ip("192.168.1.2")),
            (probe_message("uuid:x"), ip("192.168.1.3")),
        ];
        let cams = cameras_from(&packets);
        assert_eq!(cams.len(), 2);
    }

    #[test]
    fn scopes_are_decoded() {
        let scopes = vec![
            "onvif://www.onvif.org/type/video_encoder".to_string(),
            "onvif://www.onvif.org/name/Back%20Yard".to_string(),
        ];
        assert_eq!(scope(&scopes, "name").as_deref(), Some("Back Yard"));
        assert_eq!(scope(&scopes, "hardware"), None);
    }

    /// Probes the real network once and prints what answered. Run by hand:
    /// `cargo test live_discovery -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_discovery() {
        let probe = probe_message(&format!("uuid:{}", uuid::Uuid::new_v4()));
        let deadline = tokio::time::Instant::now() + PROBE_WAIT;
        let runs = interface_sockets()
            .unwrap()
            .into_iter()
            .map(|socket| collect(socket, probe.clone(), deadline));
        let packets: Vec<_> = futures_util::future::join_all(runs)
            .await
            .into_iter()
            .flatten()
            .collect();
        for (xml, from) in &packets {
            eprintln!("--- from {from}\n{xml}");
        }
        for c in cameras_from(&packets) {
            eprintln!("{c:?}");
        }
    }
}
