//! vCard → a flat shape the model can reason about.
//!
//! # Why this parses vCard itself
//!
//! The `ical` crate in the tree has a `VcardParser`, and it is not used here.
//! Its property parser requires every parameter to be `KEY=VALUE`, and vCard
//! 2.1 — which is still what Outlook exports and what half the contacts in a
//! ten-year-old address book were written by — puts bare type parameters on the
//! line instead: `TEL;CELL;VOICE:+1...`. That is a parse error, and the error is
//! raised for the whole card, so the contact vanishes rather than losing its
//! phone type. It also does not undo quoted-printable soft line breaks, which
//! is how 2.1 encodes any name with an accent in it.
//!
//! The grammar is small enough that reading it directly is less code than
//! working around those two things, and it means every version behaves the same
//! way: unknown parameters are kept, unknown properties are ignored, and
//! anything unreadable costs its own line rather than the card.
//!
//! # Photos are noted, never carried
//!
//! A `PHOTO` is a base64 JPEG, commonly 20–50 KB, which is thousands of tokens
//! per contact for something the model was not asked about. The flag says one
//! exists; the bytes stay on the server.

use serde::{Deserialize, Serialize};

/// One contact, flattened.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    /// The account this came from — the opaque UUID, echoed back verbatim.
    pub account_id: String,
    /// Its human label, so the model can match "my work address book".
    pub account_label: String,
    /// The address book within that account.
    pub address_book: String,

    /// `UID` when the card has one, otherwise the resource path it was fetched
    /// from. Never empty: it is what `contacts_get` is given to look one up.
    pub uid: String,
    /// `FN`, or a name assembled from `N` when the card omits it — 2.1 cards
    /// frequently do.
    pub full_name: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,

    #[serde(default)]
    pub emails: Vec<TypedValue>,
    #[serde(default)]
    pub phones: Vec<TypedValue>,
    #[serde(default)]
    pub addresses: Vec<TypedValue>,

    pub organization: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
    /// As written on the card: `1980-04-01`, or `--04-01` for a birthday with
    /// no year, which vCard 4.0 allows and people actually use.
    pub birthday: Option<String>,
    /// Whether a `PHOTO` exists. The bytes are deliberately not fetched.
    pub has_photo: bool,
}

/// A value that comes in kinds — home, work, mobile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TypedValue {
    /// Lowercased and de-noised: `TYPE=CELL,VOICE` becomes `mobile`. `None`
    /// when the card said nothing, which is not the same as saying "other".
    pub kind: Option<String>,
    pub value: String,
}

/// Where the contact came from, threaded through so every card can name it.
#[derive(Clone, Debug)]
pub struct ContactSource {
    pub account_id: String,
    pub account_label: String,
    pub address_book: String,
}

/// Parse a vCard document — one card or many — into contacts.
///
/// A card that yields nothing identifiable is dropped rather than returned
/// blank. Everything else degrades: a card with an unreadable phone line keeps
/// its name and its email.
pub fn parse_contacts(vcf: &str, source: &ContactSource, href_fallback: &str) -> Vec<Contact> {
    split_cards(vcf)
        .into_iter()
        .filter_map(|card| parse_card(&card, source, href_fallback))
        .collect()
}

/// Split a document into individual cards.
///
/// Driven by `BEGIN:VCARD` / `END:VCARD` rather than by parsing, so a card that
/// is malformed in the middle cannot swallow the one after it.
fn split_cards(vcf: &str) -> Vec<String> {
    let mut cards = Vec::new();
    let mut current: Option<String> = None;
    for line in vcf.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("BEGIN:VCARD") {
            // An unterminated card followed by another BEGIN: keep what was
            // read rather than discarding both.
            if let Some(card) = current.take() {
                cards.push(card);
            }
            current = Some(String::new());
            continue;
        }
        if trimmed.eq_ignore_ascii_case("END:VCARD") {
            if let Some(card) = current.take() {
                cards.push(card);
            }
            continue;
        }
        if let Some(card) = current.as_mut() {
            card.push_str(line);
            card.push('\n');
        }
    }
    if let Some(card) = current.take() {
        cards.push(card);
    }
    cards
}

/// One parsed content line.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Line {
    name: String,
    /// Parameter key → its values. A bare 2.1 parameter (`TEL;CELL:`) arrives
    /// as the key with no values, which is exactly how it is written.
    params: Vec<(String, Vec<String>)>,
    value: String,
}

impl Line {
    /// Every parameter word that could name a type, from either syntax.
    fn type_words(&self) -> Vec<String> {
        self.params
            .iter()
            .flat_map(|(key, values)| {
                if key.eq_ignore_ascii_case("TYPE") {
                    values.clone()
                } else if values.is_empty() {
                    // vCard 2.1: the key *is* the type.
                    vec![key.clone()]
                } else {
                    Vec::new()
                }
            })
            .map(|w| w.trim().to_ascii_lowercase())
            .collect()
    }

    fn has_param_word(&self, key: &str, word: &str) -> bool {
        self.params.iter().any(|(k, values)| {
            (k.eq_ignore_ascii_case(key) && values.iter().any(|v| v.eq_ignore_ascii_case(word)))
                // 2.1 writes ENCODING=QUOTED-PRINTABLE, but also bare
                // QUOTED-PRINTABLE with no key at all.
                || (values.is_empty() && k.eq_ignore_ascii_case(word))
        })
    }
}

/// Undo line folding, then split each logical line into name, params and value.
fn read_lines(card: &str) -> Vec<Line> {
    unfold(card).iter().filter_map(|l| parse_line(l)).collect()
}

/// Join continuation lines back onto the line they belong to.
///
/// Two kinds, and they look nothing alike. Standard folding indents the
/// continuation by one space or tab. Quoted-printable instead ends the line
/// with `=` and continues in column one — so a card using it produces
/// continuation lines that would otherwise parse as properties with no name.
fn unfold(card: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in card.replace("\r\n", "\n").split('\n') {
        let is_folded = raw.starts_with(' ') || raw.starts_with('\t');
        let continues_qp = out
            .last()
            .map(|prev| prev.ends_with('=') && looks_quoted_printable(prev))
            .unwrap_or(false);

        if is_folded {
            if let Some(prev) = out.last_mut() {
                prev.push_str(&raw[1..]);
                continue;
            }
        }
        if continues_qp {
            if let Some(prev) = out.last_mut() {
                prev.pop();
                prev.push_str(raw);
                continue;
            }
        }
        if raw.trim().is_empty() {
            continue;
        }
        out.push(raw.to_string());
    }
    out
}

fn looks_quoted_printable(line: &str) -> bool {
    let head = match line.find(':') {
        Some(i) => &line[..i],
        None => line,
    };
    head.to_ascii_uppercase().contains("QUOTED-PRINTABLE")
}

/// `NAME;PARAM;PARAM=VALUE,VALUE:the value`.
///
/// Everything after the first unquoted colon is the value, colons included —
/// a URL in a `URL` property is the ordinary case.
fn parse_line(line: &str) -> Option<Line> {
    let (head, value) = split_at_value(line)?;
    let mut parts = split_params(head);
    let name = parts.remove(0).trim().to_string();
    if name.is_empty() {
        return None;
    }
    // A group prefix ("item1.EMAIL") is Apple's, and means nothing to us.
    let name = name.rsplit('.').next().unwrap_or(&name).to_string();

    let params = parts
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| match p.split_once('=') {
            Some((key, values)) => (
                key.trim().to_string(),
                values
                    .split(',')
                    .map(|v| v.trim().trim_matches('"').to_string())
                    .filter(|v| !v.is_empty())
                    .collect(),
            ),
            None => (p.trim().to_string(), Vec::new()),
        })
        .collect();

    Some(Line {
        name,
        params,
        value: value.to_string(),
    })
}

/// Find the colon that ends the parameters, ignoring ones inside quotes.
fn split_at_value(line: &str) -> Option<(&str, &str)> {
    let mut quoted = false;
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => return Some((&line[..i], &line[i + 1..])),
            _ => {}
        }
    }
    None
}

/// Split the head on `;`, ignoring separators inside quoted parameter values.
fn split_params(head: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut quoted = false;
    for c in head.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                out.last_mut().expect("always one element").push(c);
            }
            ';' if !quoted => out.push(String::new()),
            _ => out.last_mut().expect("always one element").push(c),
        }
    }
    out
}

fn parse_card(card: &str, source: &ContactSource, href_fallback: &str) -> Option<Contact> {
    let lines = read_lines(card);
    let mut contact = Contact {
        account_id: source.account_id.clone(),
        account_label: source.account_label.clone(),
        address_book: source.address_book.clone(),
        ..Contact::default()
    };
    let mut structured_name: Option<Vec<String>> = None;

    for line in &lines {
        let name = line.name.to_ascii_uppercase();
        let value = decode_value(line);
        match name.as_str() {
            "UID" => contact.uid = value.trim().to_string(),
            "FN" => contact.full_name = unescape(&value).trim().to_string(),
            "N" => structured_name = Some(split_structured(&value)),
            "EMAIL" => push_typed(&mut contact.emails, line, unescape(&value), email_kind),
            "TEL" => push_typed(&mut contact.phones, line, unescape(&value), phone_kind),
            "ADR" => push_typed(
                &mut contact.addresses,
                line,
                format_address(&split_structured(&value)),
                plain_kind,
            ),
            // ORG is structured: "Company;Department". The company is the part
            // anyone means by "who do they work for".
            "ORG" => contact.organization = first_nonempty(split_structured(&value)),
            // ROLE is the fallback: a card carrying both means TITLE.
            "TITLE" | "ROLE" => {
                contact
                    .title
                    .get_or_insert_with(|| unescape(&value).trim().to_string());
            }
            "NOTE" => contact.note = non_empty(unescape(&value)),
            "BDAY" => contact.birthday = non_empty(normalize_birthday(&value)),
            "PHOTO" => contact.has_photo = !value.trim().is_empty(),
            _ => {}
        }
    }

    if let Some(parts) = structured_name {
        contact.last_name = parts.first().and_then(|s| non_empty(unescape(s)));
        contact.first_name = parts.get(1).and_then(|s| non_empty(unescape(s)));
        if contact.full_name.is_empty() {
            // 2.1 cards frequently have no FN at all.
            contact.full_name = assemble_name(&parts);
        }
    }

    if contact.full_name.is_empty() {
        // Better than a nameless entry: an address book with one contact
        // called nothing is a bug report waiting to happen.
        contact.full_name = contact
            .emails
            .first()
            .map(|e| e.value.clone())
            .or_else(|| contact.organization.clone())
            .unwrap_or_default();
    }

    if contact.uid.is_empty() {
        contact.uid = href_fallback.to_string();
    }

    // A card with no name, no email and no phone identifies nobody.
    let identifiable =
        !contact.full_name.is_empty() || !contact.emails.is_empty() || !contact.phones.is_empty();
    identifiable.then_some(contact)
}

/// Decode a value that was transfer-encoded on the wire.
fn decode_value(line: &Line) -> String {
    if line.has_param_word("ENCODING", "QUOTED-PRINTABLE") {
        return decode_quoted_printable(&line.value);
    }
    line.value.clone()
}

/// `=C3=A9` → `é`.
///
/// Decoded as bytes and then read as UTF-8, because a multi-byte character
/// arrives as several escapes and decoding them one at a time produces
/// mojibake. A `CHARSET` other than UTF-8 is not honoured — it is rare enough
/// that a replacement character in one name beats a second dependency.
fn decode_quoted_printable(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'=' && i + 2 < bytes.len() {
            let hex = &value[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Undo vCard's text escaping. Applied to every version: 2.1 does not specify
/// `\n`, but plenty of 2.1 cards in the wild contain it anyway.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Split a structured value on unescaped `;`.
fn split_structured(value: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut escaped = false;
    for c in value.chars() {
        if escaped {
            out.last_mut().expect("always one element").push('\\');
            out.last_mut().expect("always one element").push(c);
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            ';' => out.push(String::new()),
            _ => out.last_mut().expect("always one element").push(c),
        }
    }
    out
}

/// `Last;First;Middle;Prefix;Suffix` → "Prefix First Middle Last Suffix".
fn assemble_name(parts: &[String]) -> String {
    let get = |i: usize| parts.get(i).map(|s| unescape(s)).unwrap_or_default();
    [get(3), get(1), get(2), get(0), get(4)]
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `pobox;extended;street;locality;region;postcode;country` on one line.
fn format_address(parts: &[String]) -> String {
    parts
        .iter()
        .map(|p| unescape(p))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

fn push_typed(
    into: &mut Vec<TypedValue>,
    line: &Line,
    value: String,
    kind: fn(&[String]) -> Option<String>,
) {
    let value = value.trim().to_string();
    if value.is_empty() {
        return;
    }
    into.push(TypedValue {
        kind: kind(&line.type_words()),
        value,
    });
}

/// Words that appear as types but say nothing a person would say.
///
/// `INTERNET` on an email and `VOICE` on a phone are vCard 2.1 boilerplate;
/// `PREF` is an ordering hint, and this list is already in preference order.
const NOISE_TYPES: [&str; 5] = ["internet", "voice", "pref", "other", "x-internet"];

fn plain_kind(words: &[String]) -> Option<String> {
    words
        .iter()
        .find(|w| !NOISE_TYPES.contains(&w.as_str()))
        .cloned()
}

fn email_kind(words: &[String]) -> Option<String> {
    plain_kind(words)
}

/// A mobile number is written `CELL` by 2.1 and 3.0 and `cell` by 4.0, and
/// nobody says "cell phone" when reading a contact card back.
fn phone_kind(words: &[String]) -> Option<String> {
    plain_kind(words).map(|k| match k.as_str() {
        "cell" | "iphone" => "mobile".to_string(),
        other => other.to_string(),
    })
}

/// vCard 3.0 writes `19800401`; 4.0 writes `1980-04-01`. Both become the
/// second, so a model comparing two contacts' birthdays is comparing the same
/// shape.
fn normalize_birthday(value: &str) -> String {
    let trimmed = value.trim();
    // Anything with a time or a zone is trimmed to the date, which is the only
    // part of a birthday anyone means.
    let date = trimmed.split(['T', 't']).next().unwrap_or(trimmed);
    if date.len() == 8 && date.chars().all(|c| c.is_ascii_digit()) {
        return format!("{}-{}-{}", &date[0..4], &date[4..6], &date[6..8]);
    }
    date.to_string()
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn first_nonempty(parts: Vec<String>) -> Option<String> {
    parts.into_iter().find_map(|p| non_empty(unescape(&p)))
}

/// Does this contact match a free-text query?
///
/// Over the fields a person searches by — who they are, how you reach them,
/// where they work. Substring and case-insensitive, and deliberately not
/// ranked: "everyone at example.com" wants all of them, not the best three.
pub fn matches(contact: &Contact, needle: &str) -> bool {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }
    let contains = |s: &str| s.to_lowercase().contains(&needle);
    // Punctuation in a phone number is decoration: someone searching for
    // "5551234" should find "+1 (555) 123-4567". Guarded on the needle having
    // digits at all, because every number contains the empty string — without
    // this, a search for "dentist" matches everyone with a phone.
    let needle_digits = digits(&needle);
    let by_number =
        |p: &TypedValue| !needle_digits.is_empty() && digits(&p.value).contains(&needle_digits);

    contains(&contact.full_name)
        || contact.organization.as_deref().is_some_and(contains)
        || contact.title.as_deref().is_some_and(contains)
        || contact.note.as_deref().is_some_and(contains)
        || contact.emails.iter().any(|e| contains(&e.value))
        || contact.addresses.iter().any(|a| contains(&a.value))
        || contact
            .phones
            .iter()
            .any(|p| contains(&p.value) || by_number(p))
}

fn digits(value: &str) -> String {
    value.chars().filter(|c| c.is_ascii_digit()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> ContactSource {
        ContactSource {
            account_id: "acct".into(),
            account_label: "Fastmail".into(),
            address_book: "Contacts".into(),
        }
    }

    fn parse(vcf: &str) -> Vec<Contact> {
        parse_contacts(vcf, &source(), "/dav/card/x.vcf")
    }

    fn one(vcf: &str) -> Contact {
        let found = parse(vcf);
        assert_eq!(found.len(), 1, "expected one contact, got {found:?}");
        found.into_iter().next().unwrap()
    }

    #[test]
    fn a_vcard_3_card_reads_as_written() {
        let contact = one("BEGIN:VCARD\r\n\
             VERSION:3.0\r\n\
             UID:abc-123\r\n\
             FN:Sarah Okonjo\r\n\
             N:Okonjo;Sarah;;Dr;\r\n\
             EMAIL;TYPE=INTERNET,WORK:sarah@example.com\r\n\
             TEL;TYPE=CELL:+1-555-0100\r\n\
             ORG:Example Ltd;Research\r\n\
             TITLE:Director\r\n\
             END:VCARD\r\n");
        assert_eq!(contact.uid, "abc-123");
        assert_eq!(contact.full_name, "Sarah Okonjo");
        assert_eq!(contact.first_name.as_deref(), Some("Sarah"));
        assert_eq!(contact.last_name.as_deref(), Some("Okonjo"));
        assert_eq!(contact.emails[0].value, "sarah@example.com");
        // INTERNET is 2.1/3.0 boilerplate, not something a person would say.
        assert_eq!(contact.emails[0].kind.as_deref(), Some("work"));
        assert_eq!(contact.phones[0].kind.as_deref(), Some("mobile"));
        // ORG is structured; the company is what "who do they work for" means.
        assert_eq!(contact.organization.as_deref(), Some("Example Ltd"));
        assert_eq!(contact.title.as_deref(), Some("Director"));
    }

    #[test]
    fn a_vcard_4_card_reads_the_same_way() {
        let contact = one("BEGIN:VCARD\nVERSION:4.0\nFN:Ada Lovelace\n\
             EMAIL;TYPE=\"work\";PREF=1:ada@example.com\n\
             TEL;VALUE=uri;TYPE=\"voice,cell\":tel:+441234567890\n\
             BDAY:1815-12-10\nEND:VCARD\n");
        assert_eq!(contact.emails[0].kind.as_deref(), Some("work"));
        // A quoted, comma-joined type list, with the noise word first.
        assert_eq!(contact.phones[0].kind.as_deref(), Some("mobile"));
        assert_eq!(contact.birthday.as_deref(), Some("1815-12-10"));
    }

    #[test]
    fn a_vcard_2_1_card_with_bare_type_parameters_is_not_lost() {
        // The reason this module does not use `ical::VcardParser`: it treats
        // `TEL;CELL;VOICE:` as a parse error and drops the whole card.
        let contact = one("BEGIN:VCARD\r\nVERSION:2.1\r\n\
             N:Turing;Alan\r\n\
             TEL;CELL;VOICE:+44 161 000 0000\r\n\
             EMAIL;INTERNET;HOME:alan@example.com\r\n\
             END:VCARD\r\n");
        // No FN at all, which 2.1 cards routinely omit.
        assert_eq!(contact.full_name, "Alan Turing");
        assert_eq!(contact.phones[0].kind.as_deref(), Some("mobile"));
        assert_eq!(contact.emails[0].kind.as_deref(), Some("home"));
    }

    #[test]
    fn quoted_printable_names_come_back_as_the_name() {
        // How vCard 2.1 encodes any name with an accent in it. Decoded as
        // bytes then read as UTF-8: a multi-byte character arrives as several
        // escapes, and decoding them one at a time produces mojibake.
        let contact = one("BEGIN:VCARD\r\nVERSION:2.1\r\n\
             FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 Garc=C3=ADa\r\n\
             END:VCARD\r\n");
        assert_eq!(contact.full_name, "José García");
    }

    #[test]
    fn a_quoted_printable_soft_line_break_is_joined_back_up() {
        // Continues in column one rather than indented, so without this the
        // second half parses as a property with no name and is dropped. The
        // break carries no space of its own — 2.1 encoders split mid-word.
        let contact = one("BEGIN:VCARD\r\nVERSION:2.1\r\nFN:Long Note\r\n\
             NOTE;ENCODING=QUOTED-PRINTABLE:A note broken mid-w=\r\n\
             ord by a 2.1 client.\r\n\
             END:VCARD\r\n");
        assert_eq!(
            contact.note.as_deref(),
            Some("A note broken mid-word by a 2.1 client.")
        );
    }

    #[test]
    fn a_folded_line_is_joined_back_up() {
        let contact = one("BEGIN:VCARD\nVERSION:3.0\nFN:Folded\n\
             NOTE:This is a long note that the server\n  wrapped onto a second line.\n\
             END:VCARD\n");
        assert_eq!(
            contact.note.as_deref(),
            Some("This is a long note that the server wrapped onto a second line.")
        );
    }

    #[test]
    fn several_emails_and_phones_all_survive_with_their_types() {
        let contact = one("BEGIN:VCARD\nVERSION:3.0\nFN:Many Ways\n\
             EMAIL;TYPE=WORK:work@example.com\n\
             EMAIL;TYPE=HOME:home@example.com\n\
             TEL;TYPE=WORK,VOICE:+1 555 0001\n\
             TEL;TYPE=FAX:+1 555 0002\n\
             END:VCARD\n");
        assert_eq!(contact.emails.len(), 2);
        assert_eq!(contact.phones.len(), 2);
        assert_eq!(contact.emails[1].kind.as_deref(), Some("home"));
        assert_eq!(contact.phones[0].kind.as_deref(), Some("work"));
        assert_eq!(contact.phones[1].kind.as_deref(), Some("fax"));
    }

    #[test]
    fn a_photo_is_noted_and_its_bytes_are_left_on_the_server() {
        // A base64 JPEG per contact is thousands of tokens for something the
        // model was not asked about.
        let contact = one("BEGIN:VCARD\nVERSION:3.0\nFN:Has Photo\n\
             PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ\n\
             END:VCARD\n");
        assert!(contact.has_photo);
        let json = serde_json::to_string(&contact).unwrap();
        assert!(!json.contains("9j/4AAQ"), "the bytes must not travel");
    }

    #[test]
    fn a_malformed_card_costs_only_itself() {
        // Real address books accumulate junk from a decade of clients. One
        // weird entry must not fail the query.
        let found = parse(
            "BEGIN:VCARD\nVERSION:3.0\nFN:Good One\nEMAIL:good@example.com\nEND:VCARD\n\
             BEGIN:VCARD\nthis line has no colon at all\nEND:VCARD\n\
             BEGIN:VCARD\nVERSION:3.0\nFN:Good Two\nEND:VCARD\n",
        );
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].full_name, "Good One");
        assert_eq!(found[1].full_name, "Good Two");
    }

    #[test]
    fn an_unterminated_card_does_not_swallow_the_next_one() {
        let found = parse(
            "BEGIN:VCARD\nVERSION:3.0\nFN:First\n\
             BEGIN:VCARD\nVERSION:3.0\nFN:Second\nEND:VCARD\n",
        );
        assert_eq!(found.len(), 2);
        assert_eq!(found[1].full_name, "Second");
    }

    #[test]
    fn a_card_identifying_nobody_is_dropped() {
        assert!(parse("BEGIN:VCARD\nVERSION:3.0\nNOTE:just a note\nEND:VCARD\n").is_empty());
    }

    #[test]
    fn a_card_without_a_uid_is_identified_by_where_it_was_found() {
        // contacts_get needs something to look one up by.
        let contact = one("BEGIN:VCARD\nVERSION:3.0\nFN:No Uid\nEND:VCARD\n");
        assert_eq!(contact.uid, "/dav/card/x.vcf");
    }

    #[test]
    fn escaped_separators_stay_inside_their_field() {
        // A company called "Smith, Jones \u{26} Co" is one organization, not three.
        let contact = one("BEGIN:VCARD\nVERSION:3.0\nFN:Escapes\n\
             ORG:Smith\\, Jones \\; Co\n\
             NOTE:First line\\nSecond line\n\
             END:VCARD\n");
        assert_eq!(contact.organization.as_deref(), Some("Smith, Jones ; Co"));
        assert_eq!(contact.note.as_deref(), Some("First line\nSecond line"));
    }

    #[test]
    fn an_address_reads_as_one_line_without_its_empty_fields() {
        let contact = one("BEGIN:VCARD\nVERSION:3.0\nFN:Addressed\n\
             ADR;TYPE=HOME:;;12 High Street;Manchester;;M1 1AA;UK\n\
             END:VCARD\n");
        assert_eq!(
            contact.addresses[0].value,
            "12 High Street, Manchester, M1 1AA, UK"
        );
        assert_eq!(contact.addresses[0].kind.as_deref(), Some("home"));
    }

    #[test]
    fn an_apple_group_prefix_is_stripped() {
        // Apple writes "item1.EMAIL:..." with the label on a sibling line.
        let contact =
            one("BEGIN:VCARD\nVERSION:3.0\nFN:Apple\nitem1.EMAIL:apple@example.com\nEND:VCARD\n");
        assert_eq!(contact.emails[0].value, "apple@example.com");
    }

    #[test]
    fn a_url_in_a_value_is_not_cut_at_its_colon() {
        // Everything after the first unquoted colon is the value.
        let lines = read_lines("URL:https://example.com/a:b\n");
        assert_eq!(lines[0].value, "https://example.com/a:b");
    }

    #[test]
    fn birthdays_from_either_version_come_out_the_same_shape() {
        assert_eq!(normalize_birthday("19800401"), "1980-04-01");
        assert_eq!(normalize_birthday("1980-04-01"), "1980-04-01");
        assert_eq!(normalize_birthday("1980-04-01T00:00:00Z"), "1980-04-01");
        // 4.0 allows a birthday with no year, and people use it.
        assert_eq!(normalize_birthday("--0401"), "--0401");
    }

    #[test]
    fn search_matches_the_fields_a_person_would_search_by() {
        let contact = one("BEGIN:VCARD\nVERSION:3.0\nFN:Sarah Okonjo\n\
             EMAIL:sarah@example.com\nTEL:+1 (555) 123-4567\n\
             ORG:Example Ltd\nTITLE:Director\nNOTE:met at the conference\n\
             END:VCARD\n");
        assert!(matches(&contact, "okonjo"), "name");
        assert!(matches(&contact, "SARAH"), "case");
        assert!(matches(&contact, "example.com"), "email domain");
        assert!(matches(&contact, "Example Ltd"), "organization");
        assert!(matches(&contact, "director"), "title");
        assert!(matches(&contact, "conference"), "note");
        assert!(!matches(&contact, "dentist"));
    }

    #[test]
    fn a_phone_search_ignores_the_punctuation_in_the_number() {
        // Nobody types the brackets and dashes back.
        let contact =
            one("BEGIN:VCARD\nVERSION:3.0\nFN:Phoned\nTEL:+1 (555) 123-4567\nEND:VCARD\n");
        assert!(matches(&contact, "5551234"));
        assert!(matches(&contact, "555-123"));
        assert!(!matches(&contact, "5559999"));
    }

    #[test]
    fn an_empty_query_matches_everyone() {
        let contact = one("BEGIN:VCARD\nVERSION:3.0\nFN:Anyone\nEND:VCARD\n");
        assert!(matches(&contact, ""));
        assert!(matches(&contact, "   "));
    }
}
