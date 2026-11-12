//! SOAP for ONVIF: the envelope, WS-Security's UsernameToken with a password
//! digest, HTTP digest auth for cameras that want that instead, and a small
//! element tree to read responses with.
//!
//! Responses are read by local name only. Cameras bind the ONVIF namespaces
//! to whatever prefixes they like (`tt:`, `tds:`, `ns2:`…), and every element
//! read here is unambiguous without its namespace.

use base64::Engine as _;
use quick_xml::events::Event;
use quick_xml::Reader;

/// The namespaces every request uses.
const NAMESPACES: &str = concat!(
    r#"xmlns:s="http://www.w3.org/2003/05/soap-envelope" "#,
    r#"xmlns:tds="http://www.onvif.org/ver10/device/wsdl" "#,
    r#"xmlns:trt="http://www.onvif.org/ver10/media/wsdl" "#,
    r#"xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" "#,
    r#"xmlns:tt="http://www.onvif.org/ver10/schema""#
);

const WSSE: &str =
    "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU: &str =
    "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const PASSWORD_DIGEST: &str = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest";
const BASE64_BINARY: &str = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";

/// A WS-Security UsernameToken, its password sent only as a digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UsernameToken {
    pub username: String,
    /// Base64 of SHA-1(nonce + created + password).
    pub digest: String,
    /// Base64 of the nonce's raw bytes.
    pub nonce: String,
    /// When the token was made, by the camera's clock, as `xsd:dateTime`.
    pub created: String,
}

impl UsernameToken {
    pub fn new(username: &str, password: &str, nonce: &[u8], created: &str) -> Self {
        let b64 = base64::engine::general_purpose::STANDARD;
        Self {
            username: username.to_string(),
            digest: password_digest(nonce, created, password),
            nonce: b64.encode(nonce),
            created: created.to_string(),
        }
    }

    fn header(&self) -> String {
        format!(
            concat!(
                r#"<s:Header><wsse:Security s:mustUnderstand="1" xmlns:wsse="{wsse}" "#,
                r#"xmlns:wsu="{wsu}"><wsse:UsernameToken>"#,
                "<wsse:Username>{user}</wsse:Username>",
                r#"<wsse:Password Type="{pd}">{digest}</wsse:Password>"#,
                r#"<wsse:Nonce EncodingType="{b64}">{nonce}</wsse:Nonce>"#,
                "<wsu:Created>{created}</wsu:Created>",
                "</wsse:UsernameToken></wsse:Security></s:Header>"
            ),
            wsse = WSSE,
            wsu = WSU,
            user = escape(&self.username),
            pd = PASSWORD_DIGEST,
            digest = self.digest,
            b64 = BASE64_BINARY,
            nonce = self.nonce,
            created = escape(&self.created),
        )
    }
}

/// WS-Security's PasswordDigest: Base64(SHA-1(nonce + created + password)),
/// over the nonce's raw bytes.
pub(crate) fn password_digest(nonce: &[u8], created: &str, password: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(nonce);
    h.update(created.as_bytes());
    h.update(password.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

/// A SOAP 1.2 envelope around `body` (elements using the `tds`, `trt`,
/// `tptz` and `tt` prefixes), signed with `token` when there is one.
pub(crate) fn envelope(body: &str, token: Option<&UsernameToken>) -> String {
    let header = token.map(UsernameToken::header).unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><s:Envelope {NAMESPACES}>{header}<s:Body>{body}</s:Body></s:Envelope>"#
    )
}

/// Escape text for element content or an attribute value.
pub(crate) fn escape(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}

/// An `Authorization: Digest …` value answering `challenge` (a
/// `WWW-Authenticate` header), or `None` when it isn't a digest challenge
/// this understands. `uri` is the request's path and query.
pub(crate) fn digest_authorization(
    challenge: &str,
    method: &str,
    uri: &str,
    username: &str,
    password: &str,
    cnonce: &str,
) -> Option<String> {
    let rest = challenge.trim();
    if rest.len() < 7 || !rest[..7].eq_ignore_ascii_case("digest ") {
        return None;
    }
    let params = auth_params(&rest[7..]);
    let get = |k: &str| {
        params
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.as_str())
    };
    let realm = get("realm").unwrap_or("");
    let nonce = get("nonce")?;
    let algorithm = get("algorithm").unwrap_or("MD5");
    let hash: fn(&str) -> String = if algorithm.eq_ignore_ascii_case("MD5") {
        |s| {
            use md5::{Digest, Md5};
            crate::hash_util::hex(&Md5::digest(s.as_bytes()))
        }
    } else if algorithm.eq_ignore_ascii_case("SHA-256") {
        |s| {
            use sha2::{Digest, Sha256};
            crate::hash_util::hex(&Sha256::digest(s.as_bytes()))
        }
    } else {
        return None;
    };
    let auth_qop = get("qop").is_some_and(|q| {
        q.split(',')
            .any(|one| one.trim().eq_ignore_ascii_case("auth"))
    });
    let ha1 = hash(&format!("{username}:{realm}:{password}"));
    let ha2 = hash(&format!("{method}:{uri}"));
    let nc = "00000001";
    let response = if auth_qop {
        hash(&format!("{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}"))
    } else {
        hash(&format!("{ha1}:{nonce}:{ha2}"))
    };
    let quote = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut out = format!(
        r#"Digest username="{}", realm="{}", nonce="{}", uri="{}", algorithm={algorithm}, response="{response}""#,
        quote(username),
        quote(realm),
        quote(nonce),
        quote(uri),
    );
    if auth_qop {
        out.push_str(&format!(r#", qop=auth, nc={nc}, cnonce="{cnonce}""#));
    }
    if let Some(opaque) = get("opaque") {
        out.push_str(&format!(r#", opaque="{}""#, quote(opaque)));
    }
    Some(out)
}

/// `name=value` pairs from an auth header, values quoted or not.
fn auth_params(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut chars = s.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| *c == ',' || c.is_whitespace()) {
            chars.next();
        }
        let name: String = chars.by_ref().take_while(|c| *c != '=').collect();
        if name.trim().is_empty() {
            break;
        }
        let mut value = String::new();
        if chars.peek() == Some(&'"') {
            chars.next();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => value.extend(chars.next()),
                    '"' => break,
                    c => value.push(c),
                }
            }
        } else {
            while let Some(c) = chars.peek().copied() {
                if c == ',' {
                    break;
                }
                value.push(c);
                chars.next();
            }
        }
        out.push((name.trim().to_string(), value.trim().to_string()));
    }
    out
}

/// One element of a parsed response, named by its local name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Element {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Element>,
    /// Its own text, unescaped.
    pub text: String,
}

impl Element {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// The first child named `name`.
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// The element down a path of child names.
    pub fn path(&self, names: &[&str]) -> Option<&Element> {
        names.iter().try_fold(self, |el, n| el.child(n))
    }

    /// The trimmed text down a path of child names; `None` when it is absent
    /// or empty.
    pub fn text_at(&self, names: &[&str]) -> Option<&str> {
        self.path(names)
            .map(|e| e.text.trim())
            .filter(|t| !t.is_empty())
    }

    /// The first element named `name` at any depth, this one included.
    pub fn find(&self, name: &str) -> Option<&Element> {
        if self.name == name {
            return Some(self);
        }
        self.children.iter().find_map(|c| c.find(name))
    }
}

/// Parse a document into its root element.
pub(crate) fn parse(xml: &str) -> Result<Element, String> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Element> = Vec::new();
    let mut root = None;
    let open = |e: &quick_xml::events::BytesStart| -> Result<Element, String> {
        let mut attrs = Vec::new();
        for a in e.attributes() {
            let a = a.map_err(|err| format!("bad attribute: {err}"))?;
            let value = a
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .map_err(|err| format!("bad attribute: {err}"))?
                .into_owned();
            attrs.push((local_name(a.key.into_inner()), value));
        }
        Ok(Element {
            name: local_name(e.name().into_inner()),
            attrs,
            ..Element::default()
        })
    };
    loop {
        let event = reader
            .read_event()
            .map_err(|e| format!("the camera's reply isn't readable XML: {e}"))?;
        match event {
            Event::Start(e) => stack.push(open(&e)?),
            Event::Empty(e) => {
                let el = open(&e)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(el),
                    None => root = root.or(Some(el)),
                }
            }
            Event::End(_) => {
                let el = stack
                    .pop()
                    .ok_or("the camera's reply has an unbalanced tag")?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(el),
                    None => root = root.or(Some(el)),
                }
            }
            Event::Text(e) => {
                if let Some(el) = stack.last_mut() {
                    el.text.push_str(&e.xml10_content());
                }
            }
            Event::CData(e) => {
                if let Some(el) = stack.last_mut() {
                    el.text.push_str(&e.into_inner());
                }
            }
            Event::GeneralRef(e) => {
                if let Some(el) = stack.last_mut() {
                    let resolved = match e.resolve_char_ref() {
                        Ok(Some(c)) => c.to_string(),
                        _ => quick_xml::escape::resolve_predefined_entity(&e.into_inner())
                            .unwrap_or_default()
                            .to_string(),
                    };
                    el.text.push_str(&resolved);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    root.ok_or_else(|| "the camera's reply is empty".to_string())
}

fn local_name(raw: impl AsRef<[u8]>) -> String {
    let name = String::from_utf8_lossy(raw.as_ref());
    name.rsplit(':').next().unwrap_or(&name).to_string()
}

/// The reason in a SOAP fault, when `root` is one.
pub(crate) fn fault(root: &Element) -> Option<String> {
    let fault = root.find("Fault")?;
    let reason = fault
        .find("Reason")
        .and_then(|r| r.find("Text"))
        .map(|t| t.text.trim().to_string())
        .or_else(|| fault.find("faultstring").map(|t| t.text.trim().to_string()))
        .filter(|t| !t.is_empty());
    // The innermost subcode names the failure (`ter:NotAuthorized`).
    let mut code = fault.find("Code");
    let mut subcode = None;
    while let Some(c) = code {
        if let Some(v) = c.child("Value") {
            subcode = Some(v.text.trim().rsplit(':').next().unwrap_or("").to_string());
        }
        code = c.child("Subcode");
    }
    match (reason, subcode.filter(|s| !s.is_empty())) {
        (Some(r), _) => Some(r),
        (None, Some(s)) => Some(s),
        (None, None) => Some("the camera refused the request".into()),
    }
}

/// The body's first element, the response itself.
pub(crate) fn body(root: &Element) -> Option<&Element> {
    root.find("Body").and_then(|b| b.children.first())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_password_digest_matches_the_onvif_guide() {
        // The worked example in the ONVIF Application Programmer's Guide.
        let nonce = base64::engine::general_purpose::STANDARD
            .decode("LKqI6G/AikKCQrN0zqZFlg==")
            .unwrap();
        assert_eq!(
            password_digest(&nonce, "2010-09-16T07:50:45Z", "userpassword"),
            "tuOSpGlFlIXsozq4HFNeeGeFLEI="
        );
    }

    #[test]
    fn a_token_digests_raw_nonce_bytes_and_the_utf8_password() {
        // Worked out separately with Python's hashlib.
        let nonce: Vec<u8> = (0u8..16).collect();
        let t = UsernameToken::new("admin", "p@ss wörd&<", &nonce, "2026-11-12T09:30:00Z");
        assert_eq!(t.nonce, "AAECAwQFBgcICQoLDA0ODw==");
        assert_eq!(t.digest, "wogKzw6FDQUOCUxr9nrksty2XRE=");
    }

    #[test]
    fn the_envelope_carries_the_token_and_never_the_password() {
        let nonce: Vec<u8> = (0u8..16).collect();
        let t = UsernameToken::new("ad<min", "p@ss wörd&<", &nonce, "2026-11-12T09:30:00Z");
        let xml = envelope("<tds:GetCapabilities/>", Some(&t));
        assert!(!xml.contains("p@ss"));
        let root = parse(&xml).unwrap();
        let token = root.find("UsernameToken").unwrap();
        assert_eq!(token.text_at(&["Username"]), Some("ad<min"));
        assert_eq!(
            token.text_at(&["Password"]),
            Some("wogKzw6FDQUOCUxr9nrksty2XRE=")
        );
        assert_eq!(
            token.child("Password").unwrap().attr("Type"),
            Some(PASSWORD_DIGEST)
        );
        assert_eq!(token.text_at(&["Nonce"]), Some("AAECAwQFBgcICQoLDA0ODw=="));
        assert_eq!(token.text_at(&["Created"]), Some("2026-11-12T09:30:00Z"));
        assert_eq!(body(&root).unwrap().name, "GetCapabilities");
        let bare = envelope("<tds:GetSystemDateAndTime/>", None);
        assert!(!bare.contains("Security"));
    }

    #[test]
    fn http_digest_matches_rfc_2617() {
        let challenge = r#"Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41""#;
        let auth = digest_authorization(
            challenge,
            "GET",
            "/dir/index.html",
            "Mufasa",
            "Circle Of Life",
            "0a4f113b",
        )
        .unwrap();
        assert!(auth.contains(r#"response="6629fae49393a05397450978507c4ef1""#));
        assert!(auth.contains("qop=auth, nc=00000001"));
        assert!(auth.contains(r#"opaque="5ccc069c403ebaf9f0171e9517f40e41""#));
    }

    #[test]
    fn http_digest_without_qop() {
        // Worked out separately with Python's hashlib.
        let auth = digest_authorization(
            r#"Digest realm="onvif", nonce=abc123"#,
            "POST",
            "/onvif/device_service",
            "admin",
            "secret",
            "x",
        )
        .unwrap();
        assert!(auth.contains(r#"response="de9ab7760b6dc1f2156bad09d3365328""#));
        assert!(!auth.contains("qop"));
        assert!(digest_authorization(r#"Basic realm="x""#, "POST", "/", "a", "b", "c").is_none());
        assert!(digest_authorization(
            r#"Digest realm="x", nonce="n", algorithm=SHA-512-256"#,
            "POST",
            "/",
            "a",
            "b",
            "c"
        )
        .is_none());
    }

    #[test]
    fn faults_give_their_reason_or_subcode() {
        let xml = include_str!("fixtures/fault_not_authorized.xml");
        let root = parse(xml).unwrap();
        assert_eq!(fault(&root).as_deref(), Some("Sender not authorized"));
        let bare = r#"<s:Envelope xmlns:s="x"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value>
            <s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code></s:Fault></s:Body></s:Envelope>"#;
        assert_eq!(
            fault(&parse(bare).unwrap()).as_deref(),
            Some("NotAuthorized")
        );
        let ok = parse(include_str!("fixtures/generic_get_capabilities.xml")).unwrap();
        assert!(fault(&ok).is_none());
    }

    #[test]
    fn entities_and_prefixes_are_resolved() {
        let root =
            parse(r#"<a:x xmlns:a="u"><b:y q:k="1&amp;2">one &amp; two&#33;</b:y><z/></a:x>"#)
                .unwrap();
        assert_eq!(root.name, "x");
        let y = root.child("y").unwrap();
        assert_eq!(y.text, "one & two!");
        assert_eq!(y.attr("k"), Some("1&2"));
        assert!(root.child("z").is_some());
    }
}
