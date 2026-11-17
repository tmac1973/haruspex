//! Finding your other computers on the LAN without typing an address: a
//! Haruspex whose Remote control listens on every network says so over mDNS
//! (`_haruspex._tcp`), and one with Settings → Remote control → Other
//! computers on looks for them. `mdns-sd` speaks it itself, so neither Avahi
//! nor Bonjour is needed.
//!
//! mDNS is unauthenticated: a record only says where to probe. The
//! fingerprint isn't sent; the owner confirms it by eye before trusting.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;

use crate::owner::identity::InstanceIdentity;
use crate::sync_util::LockExt;

pub const SERVICE: &str = "_haruspex._tcp.local.";

/// Another Haruspex seen on the LAN, not yet trusted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FoundPeer {
    pub instance_id: String,
    pub name: String,
    /// IPv4 first, as `peers::client` tries them.
    pub addresses: Vec<String>,
    pub port: u16,
    pub version: String,
}

/// Hears every change to the found list, whole.
pub type OnFound = Arc<dyn Fn(&[FoundPeer]) + Send + Sync>;

/// The record a resolved service makes, or `None` for one without an id,
/// for this Haruspex itself, or with no address another computer can use: on
/// one machine a record can arrive over loopback first.
fn found_from(service: &ResolvedService, own_id: &str) -> Option<FoundPeer> {
    let id = service.get_property_val_str("id")?.trim();
    if id.is_empty() || id == own_id {
        return None;
    }
    let mut ips: Vec<IpAddr> = service
        .get_addresses()
        .iter()
        .map(|a| a.to_ip_addr())
        .filter(|ip| usable(*ip))
        .collect();
    if ips.is_empty() {
        return None;
    }
    ips.sort_by_key(|ip| (ip.is_ipv6(), *ip));
    ips.dedup();
    Some(FoundPeer {
        instance_id: id.to_string(),
        name: mdns_sd::instance_name_unescaped(&service.fullname),
        addresses: ips.iter().map(IpAddr::to_string).collect(),
        port: service.port,
        version: service
            .get_property_val_str("v")
            .unwrap_or_default()
            .to_string(),
    })
}

/// Not loopback, and not an IPv6 link-local address, which needs a scope id
/// that a URL can't carry.
fn usable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => !v4.is_loopback(),
        IpAddr::V6(v6) => !v6.is_loopback() && (v6.segments()[0] & 0xffc0) != 0xfe80,
    }
}

/// What's been found, keyed by the service's full name so a removal (which
/// carries only that) finds its entry.
#[derive(Default)]
struct Found(HashMap<String, FoundPeer>);

impl Found {
    /// Latest wins for an instance id, whatever name it now goes by.
    fn resolved(&mut self, fullname: &str, peer: FoundPeer) {
        self.0
            .retain(|name, p| name == fullname || p.instance_id != peer.instance_id);
        self.0.insert(fullname.to_string(), peer);
    }

    fn removed(&mut self, fullname: &str) -> bool {
        self.0.remove(fullname).is_some()
    }

    fn list(&self) -> Vec<FoundPeer> {
        let mut list: Vec<FoundPeer> = self.0.values().cloned().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name).then(a.instance_id.cmp(&b.instance_id)));
        list
    }
}

struct Browsing {
    found: Arc<Mutex<Found>>,
    /// Cleared on stop, so a late event from the old browse isn't reported.
    alive: Arc<AtomicBool>,
}

/// What's advertised: compared so an unchanged apply sends nothing.
#[derive(Clone, PartialEq, Eq)]
struct Advert {
    fullname: String,
    name: String,
    port: u16,
}

#[derive(Default)]
struct State {
    daemon: Option<ServiceDaemon>,
    advert: Option<Advert>,
    browsing: Option<Browsing>,
    /// A daemon that couldn't start is said once, not on every apply.
    warned: bool,
}

impl State {
    fn daemon(&mut self) -> Option<&ServiceDaemon> {
        if self.daemon.is_none() {
            match ServiceDaemon::new() {
                Ok(d) => self.daemon = Some(d),
                Err(e) => {
                    if !std::mem::replace(&mut self.warned, true) {
                        log::warn!("[peers] mDNS unavailable, add computers by address: {e}");
                    }
                    return None;
                }
            }
        }
        self.daemon.as_ref()
    }

    /// Nothing on port 5353 while neither side is wanted.
    fn shut_down_if_idle(&mut self) {
        if self.advert.is_none() && self.browsing.is_none() {
            if let Some(d) = self.daemon.take() {
                let _ = d.shutdown();
            }
        }
    }
}

/// Managed state: one daemon for advertising and browsing, alive only while
/// either is.
#[derive(Default)]
pub struct Mdns {
    state: Mutex<State>,
}

impl Mdns {
    /// Say this Haruspex is here, on `port`. Replaces an earlier advert.
    pub fn advertise(&self, identity: &InstanceIdentity, port: u16) {
        let mut state = self.state.lock_or_recover();
        let wanted = Advert {
            fullname: format!("{}.{SERVICE}", escape(&identity.name)),
            name: identity.name.clone(),
            port,
        };
        if state.advert.as_ref() == Some(&wanted) {
            return;
        }
        unregister(&mut state);
        let Some(daemon) = state.daemon() else {
            return;
        };
        // Its own host name, not the computer's: Avahi or Bonjour may already
        // answer for `<name>.local.`.
        let short: String = identity.id.chars().filter(|c| *c != '-').take(8).collect();
        let host = format!("haruspex-{short}.local.");
        let version = env!("CARGO_PKG_VERSION");
        let txt = [("id", identity.id.as_str()), ("v", version), ("api", "1")];
        let no_ips: &[IpAddr] = &[];
        let registered = ServiceInfo::new(SERVICE, &identity.name, &host, no_ips, port, &txt[..])
            .map(ServiceInfo::enable_addr_auto)
            .and_then(|info| {
                let fullname = info.get_fullname().to_string();
                daemon.register(info).map(|()| fullname)
            });
        match registered {
            Ok(fullname) => state.advert = Some(Advert { fullname, ..wanted }),
            Err(e) => log::warn!("[peers] couldn't advertise over mDNS: {e}"),
        }
        state.shut_down_if_idle();
    }

    /// Stop saying this Haruspex is here.
    pub fn unadvertise(&self) {
        let mut state = self.state.lock_or_recover();
        unregister(&mut state);
        state.shut_down_if_idle();
    }

    /// Look for others, reporting each change through `on_found`. Already
    /// browsing: nothing changes.
    pub fn browse_start(&self, own_id: &str, on_found: OnFound) {
        let mut state = self.state.lock_or_recover();
        if state.browsing.is_some() {
            return;
        }
        let Some(daemon) = state.daemon() else {
            return;
        };
        let events = match daemon.browse(SERVICE) {
            Ok(rx) => rx,
            Err(e) => {
                log::warn!("[peers] couldn't look for computers over mDNS: {e}");
                state.shut_down_if_idle();
                return;
            }
        };
        let found = Arc::new(Mutex::new(Found::default()));
        let alive = Arc::new(AtomicBool::new(true));
        state.browsing = Some(Browsing {
            found: found.clone(),
            alive: alive.clone(),
        });
        let own_id = own_id.to_string();
        // mdns-sd has its own thread and a blocking channel: one more thread
        // to read it, ending when the browse stops or the daemon shuts down.
        let spawned = std::thread::Builder::new()
            .name("peers-mdns".into())
            .spawn(move || {
                while let Ok(event) = events.recv() {
                    if !alive.load(Ordering::Acquire) {
                        break;
                    }
                    let changed = match event {
                        ServiceEvent::ServiceResolved(service) => {
                            match found_from(&service, &own_id) {
                                Some(peer) => {
                                    found.lock_or_recover().resolved(&service.fullname, peer);
                                    true
                                }
                                None => false,
                            }
                        }
                        ServiceEvent::ServiceRemoved(_, fullname) => {
                            found.lock_or_recover().removed(&fullname)
                        }
                        ServiceEvent::SearchStopped(_) => break,
                        _ => false,
                    };
                    if changed && alive.load(Ordering::Acquire) {
                        let list = found.lock_or_recover().list();
                        on_found(&list);
                    }
                }
            });
        if let Err(e) = spawned {
            log::warn!("[peers] couldn't look for computers over mDNS: {e}");
            stop_browsing(&mut state);
        }
    }

    /// Stop looking, and forget what was found.
    pub fn browse_stop(&self) {
        let mut state = self.state.lock_or_recover();
        stop_browsing(&mut state);
    }

    /// What browsing has found so far: empty while it's off.
    pub fn found(&self) -> Vec<FoundPeer> {
        let state = self.state.lock_or_recover();
        state
            .browsing
            .as_ref()
            .map(|b| b.found.lock_or_recover().list())
            .unwrap_or_default()
    }
}

fn unregister(state: &mut State) {
    if let Some(advert) = state.advert.take() {
        if let Some(d) = state.daemon.as_ref() {
            let _ = d.unregister(&advert.fullname);
        }
    }
}

fn stop_browsing(state: &mut State) {
    if let Some(b) = state.browsing.take() {
        b.alive.store(false, Ordering::Release);
        if let Some(d) = state.daemon.as_ref() {
            let _ = d.stop_browse(SERVICE);
        }
    }
    state.shut_down_if_idle();
}

/// An instance name as it appears in a full name.
fn escape(name: &str) -> String {
    name.replace('\\', "\\\\").replace('.', "\\.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    const OURS: &str = "11111111-2222-3333-4444-555555555555";
    const THEIRS: &str = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

    fn service(name: &str, txt: &[(&str, &str)], ips: &[&str]) -> ResolvedService {
        ServiceInfo::new(SERVICE, name, "desk-pc.local.", ips, 8788, txt)
            .unwrap()
            .as_resolved_service()
    }

    #[test]
    fn a_record_becomes_a_found_computer() {
        let s = service(
            "desk-pc",
            &[("id", THEIRS), ("v", "0.2.18"), ("api", "1")],
            &["fd28::8ac", "fe80::1", "192.168.1.20", "127.0.0.1"],
        );
        let peer = found_from(&s, OURS).unwrap();
        assert_eq!(
            peer,
            FoundPeer {
                instance_id: THEIRS.into(),
                name: "desk-pc".into(),
                addresses: vec!["192.168.1.20".into(), "fd28::8ac".into()],
                port: 8788,
                version: "0.2.18".into(),
            }
        );
    }

    #[test]
    fn a_dotted_name_is_read_back_whole() {
        let s = service("Tim's Mac.home", &[("id", THEIRS)], &["192.168.1.20"]);
        assert_eq!(found_from(&s, OURS).unwrap().name, "Tim's Mac.home");
        assert_eq!(
            s.fullname,
            format!("{}.{SERVICE}", escape("Tim's Mac.home"))
        );
    }

    #[test]
    fn this_computer_and_records_without_an_id_or_address_are_skipped() {
        let ours = service("laptop", &[("id", OURS)], &["192.168.1.21"]);
        assert_eq!(found_from(&ours, OURS), None);
        let none = service("printer", &[("v", "1")], &["192.168.1.22"]);
        assert_eq!(found_from(&none, OURS), None);
        let blank = service("blank", &[("id", " ")], &["192.168.1.23"]);
        assert_eq!(found_from(&blank, OURS), None);
        let local = service("desk-pc", &[("id", THEIRS)], &["127.0.0.1", "fe80::1"]);
        assert_eq!(found_from(&local, OURS), None);
    }

    fn peer(id: &str, name: &str) -> FoundPeer {
        FoundPeer {
            instance_id: id.into(),
            name: name.into(),
            addresses: vec!["192.168.1.20".into()],
            port: 8788,
            version: "0.2.18".into(),
        }
    }

    #[test]
    fn one_entry_per_computer_and_removal_drops_it() {
        let mut found = Found::default();
        found.resolved("desk-pc._haruspex._tcp.local.", peer(THEIRS, "desk-pc"));
        // Renamed: the same computer under a new name replaces the old entry.
        found.resolved("study._haruspex._tcp.local.", peer(THEIRS, "study"));
        found.resolved("laptop._haruspex._tcp.local.", peer(OURS, "laptop"));
        let names: Vec<String> = found.list().into_iter().map(|p| p.name).collect();
        assert_eq!(names, ["laptop", "study"]);

        assert!(found.removed("study._haruspex._tcp.local."));
        assert!(!found.removed("desk-pc._haruspex._tcp.local."));
        assert_eq!(found.list(), vec![peer(OURS, "laptop")]);
    }

    #[test]
    fn nothing_runs_until_asked_and_stops_when_neither_is_wanted() {
        let mdns = Mdns::default();
        assert!(mdns.state.lock_or_recover().daemon.is_none());
        mdns.unadvertise();
        mdns.browse_stop();
        assert!(mdns.state.lock_or_recover().daemon.is_none());
        assert!(mdns.found().is_empty());
    }

    /// Two Haruspex on one machine, one advertising and one browsing. Needs
    /// multicast on a real interface, which CI runners and sandboxes may not
    /// have: `cargo test peers::mdns -- --ignored`.
    #[test]
    #[ignore]
    fn one_computer_finds_another() {
        let advertiser = Mdns::default();
        let theirs = InstanceIdentity {
            id: THEIRS.into(),
            name: "desk-pc-test".into(),
        };
        advertiser.advertise(&theirs, 48788);

        let browser = Mdns::default();
        let seen = Arc::new(Mutex::new(Vec::<FoundPeer>::new()));
        let sink = seen.clone();
        browser.browse_start(
            OURS,
            Arc::new(move |list: &[FoundPeer]| *sink.lock_or_recover() = list.to_vec()),
        );

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && !seen
                .lock_or_recover()
                .iter()
                .any(|p| p.instance_id == THEIRS)
        {
            std::thread::sleep(Duration::from_millis(100));
        }
        let found = browser.found();
        let peer = found
            .iter()
            .find(|p| p.instance_id == THEIRS)
            .expect("found");
        assert_eq!(peer.name, "desk-pc-test");
        assert_eq!(peer.port, 48788);
        assert_eq!(peer.version, env!("CARGO_PKG_VERSION"));
        assert!(!peer.addresses.is_empty());

        browser.browse_stop();
        advertiser.unadvertise();
        assert!(browser.state.lock_or_recover().daemon.is_none());
        assert!(advertiser.state.lock_or_recover().daemon.is_none());
    }
}
