//! Parsing one `SKILL.md`: YAML frontmatter between `---` lines, then a
//! Markdown body.
//!
//! Lenient by design, following the agentskills.io client guide: skills are
//! written for many clients, and plenty of them break a rule some other
//! parser never checked. A problem that still leaves a usable skill is a
//! warning; only a missing description or unreadable frontmatter makes the
//! skill unusable, because the description is what the model and the
//! autocomplete go by.

use std::collections::BTreeMap;

use serde_norway::Value;

const NAME_MAX: usize = 64;
const DESCRIPTION_MAX: usize = 1024;
const COMPATIBILITY_MAX: usize = 500;

/// What a `SKILL.md` says about itself, plus anything wrong with it.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub metadata: BTreeMap<String, String>,
    pub allowed_tools: Option<String>,
    pub body: String,
    /// Problems that leave the skill usable.
    pub warnings: Vec<String>,
    /// Why the skill can't be used, when it can't.
    pub error: Option<String>,
}

/// Parse `text`, the contents of `<folder>/SKILL.md`. Never fails: an unusable
/// skill comes back with `error` set and `name` taken from its folder, so the
/// user can be shown what is wrong with it.
pub fn parse_skill(text: &str, folder: &str) -> ParsedSkill {
    let mut out = ParsedSkill {
        name: folder.to_string(),
        ..Default::default()
    };
    let text = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n");
    let (yaml, body) = match split_frontmatter(&text) {
        Ok(parts) => parts,
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    };
    out.body = body.trim().to_string();

    let map = match parse_yaml(yaml) {
        Ok(Value::Mapping(map)) => map,
        Ok(_) => {
            out.error = Some("the frontmatter is not a list of fields".into());
            return out;
        }
        Err(e) => {
            out.error = Some(format!("the frontmatter is not valid YAML: {e}"));
            return out;
        }
    };
    let field = |key: &str| map.get(key).and_then(scalar_string);

    match field("name") {
        Some(name) if !name.trim().is_empty() => out.name = name.trim().to_string(),
        _ => out
            .warnings
            .push(format!("no name; using the folder name \"{folder}\"")),
    }
    out.description = field("description").unwrap_or_default().trim().to_string();
    out.license = field("license");
    out.compatibility = field("compatibility");
    out.allowed_tools = field("allowed-tools");
    if let Some(Value::Mapping(meta)) = map.get("metadata") {
        for (k, v) in meta {
            match (scalar_string(k), scalar_string(v)) {
                (Some(k), Some(v)) => {
                    out.metadata.insert(k, v);
                }
                (Some(k), None) => out
                    .warnings
                    .push(format!("metadata \"{k}\" is not a plain value; ignored")),
                _ => {}
            }
        }
    }

    if out.description.is_empty() {
        out.error = Some("no description".into());
        return out;
    }
    out.warnings.extend(check_limits(&out, folder));
    out
}

/// The YAML between the opening and closing `---`, and everything after.
fn split_frontmatter(text: &str) -> Result<(&str, &str), String> {
    let rest = text
        .strip_prefix("---")
        .filter(|r| r.starts_with('\n') || r.trim_start_matches([' ', '\t']).starts_with('\n'))
        .ok_or("SKILL.md does not start with a --- frontmatter block")?;
    let rest = &rest[rest.find('\n').map_or(rest.len(), |i| i + 1)..];
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Ok((&rest[..offset], &rest[offset + line.len()..]));
        }
        offset += line.len();
    }
    Err("the frontmatter has no closing ---".into())
}

/// Parse the frontmatter, retrying once with colon-bearing values quoted.
///
/// `description: Use this when: the user asks about PDFs` is invalid YAML (a
/// second `: ` in a plain scalar) that several clients' parsers accept anyway,
/// so skills written for them carry it. Quoting such values is the fix the
/// client guide suggests.
fn parse_yaml(yaml: &str) -> Result<Value, serde_norway::Error> {
    if yaml.trim().is_empty() {
        return Ok(Value::Mapping(Default::default()));
    }
    match serde_norway::from_str(yaml) {
        Ok(v) => Ok(v),
        Err(first) => match quote_colon_values(yaml) {
            Some(fixed) => serde_norway::from_str(&fixed).map_err(|_| first),
            None => Err(first),
        },
    }
}

/// `yaml` with every top-level plain value containing `: ` wrapped in double
/// quotes, or None when there is nothing to fix.
fn quote_colon_values(yaml: &str) -> Option<String> {
    let mut changed = false;
    let lines: Vec<String> = yaml
        .lines()
        .map(|line| {
            let Some((key, value)) = line.split_once(": ") else {
                return line.to_string();
            };
            let plain_key = !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            let value = value.trim();
            let plain_value = !value.is_empty()
                && !value.starts_with(['"', '\'', '|', '>', '[', '{', '&', '*', '!', '#']);
            if plain_key && plain_value && value.contains(": ") {
                changed = true;
                let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
                format!("{key}: \"{escaped}\"")
            } else {
                line.to_string()
            }
        })
        .collect();
    changed.then(|| lines.join("\n"))
}

/// A YAML scalar as a string; None for a mapping, sequence or null.
fn scalar_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The spec's rules that a skill can break and still be used.
fn check_limits(skill: &ParsedSkill, folder: &str) -> Vec<String> {
    let mut warnings = Vec::new();
    let name = &skill.name;
    if name != folder {
        warnings.push(format!(
            "name \"{name}\" does not match its folder \"{folder}\""
        ));
    }
    if name.chars().count() > NAME_MAX {
        warnings.push(format!("name is longer than {NAME_MAX} characters"));
    }
    let valid_chars = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid_chars || name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        warnings.push(
            "name should be lowercase letters, digits and single hyphens, \
             not starting or ending with a hyphen"
                .into(),
        );
    }
    if skill.description.chars().count() > DESCRIPTION_MAX {
        warnings.push(format!(
            "description is longer than {DESCRIPTION_MAX} characters"
        ));
    }
    if skill
        .compatibility
        .as_ref()
        .is_some_and(|c| c.chars().count() > COMPATIBILITY_MAX)
    {
        warnings.push(format!(
            "compatibility is longer than {COMPATIBILITY_MAX} characters"
        ));
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(front: &str, body: &str) -> String {
        format!("---\n{front}\n---\n{body}")
    }

    #[test]
    fn parses_a_valid_skill() {
        let s = parse_skill(
            &skill(
                "name: pdf-tools\ndescription: Work with PDFs.\nlicense: MIT\n\
                 compatibility: Needs poppler\nallowed-tools: Bash(pdftotext:*) Read\n\
                 metadata:\n  author: me\n  version: \"1.0\"",
                "\n# PDF tools\n\nDo the thing.\n",
            ),
            "pdf-tools",
        );
        assert_eq!(s.error, None);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        assert_eq!(s.name, "pdf-tools");
        assert_eq!(s.description, "Work with PDFs.");
        assert_eq!(s.license.as_deref(), Some("MIT"));
        assert_eq!(s.compatibility.as_deref(), Some("Needs poppler"));
        assert_eq!(s.allowed_tools.as_deref(), Some("Bash(pdftotext:*) Read"));
        assert_eq!(s.metadata.get("version").map(String::as_str), Some("1.0"));
        assert_eq!(s.body, "# PDF tools\n\nDo the thing.");
    }

    #[test]
    fn missing_description_makes_it_unusable() {
        let s = parse_skill(&skill("name: x", "body"), "x");
        assert_eq!(s.error.as_deref(), Some("no description"));
        let s = parse_skill(&skill("name: x\ndescription: \"  \"", "body"), "x");
        assert_eq!(s.error.as_deref(), Some("no description"));
    }

    #[test]
    fn unreadable_frontmatter_makes_it_unusable() {
        let s = parse_skill("# Just markdown\n", "x");
        assert!(s.error.unwrap().contains("does not start"));
        let s = parse_skill("---\nname: x\ndescription: y\n", "x");
        assert!(s.error.unwrap().contains("no closing"));
        let s = parse_skill(&skill("name: [unclosed\ndescription: y", ""), "x");
        assert!(s.error.unwrap().contains("not valid YAML"));
        let s = parse_skill(&skill("- a\n- b", ""), "x");
        assert!(s.error.unwrap().contains("not a list of fields"));
        // The name falls back to the folder so the error can be shown against it.
        assert_eq!(parse_skill("nope", "my-folder").name, "my-folder");
    }

    #[test]
    fn rule_breaks_warn_but_load() {
        let s = parse_skill(&skill("name: PDF--Tools\ndescription: d", ""), "pdf");
        assert_eq!(s.error, None);
        assert_eq!(s.name, "PDF--Tools");
        assert_eq!(s.warnings.len(), 2, "{:?}", s.warnings);
        assert!(s.warnings[0].contains("does not match its folder"));

        let long = "a".repeat(65);
        let s = parse_skill(&skill(&format!("name: {long}\ndescription: d"), ""), &long);
        assert!(s.warnings.iter().any(|w| w.contains("longer than 64")));

        let s = parse_skill(
            &skill(&format!("name: x\ndescription: {}", "d".repeat(1025)), ""),
            "x",
        );
        assert_eq!(s.error, None);
        assert!(s
            .warnings
            .iter()
            .any(|w| w.contains("description is longer")));
    }

    #[test]
    fn missing_name_uses_the_folder() {
        let s = parse_skill(&skill("description: d", "b"), "from-folder");
        assert_eq!(s.name, "from-folder");
        assert_eq!(s.error, None);
        assert!(s.warnings[0].contains("no name"));
    }

    #[test]
    fn retries_an_unquoted_colon_value() {
        let s = parse_skill(
            &skill(
                "name: pdf\ndescription: Use this when: the user asks about PDFs",
                "",
            ),
            "pdf",
        );
        assert_eq!(s.error, None);
        assert_eq!(s.description, "Use this when: the user asks about PDFs");
    }

    #[test]
    fn handles_crlf_bom_and_block_scalars() {
        let text =
            "\u{feff}---\r\nname: x\r\ndescription: >\r\n  Folded\r\n  text\r\n---\r\nBody\r\n";
        let s = parse_skill(text, "x");
        assert_eq!(s.error, None);
        assert_eq!(s.description, "Folded text");
        assert_eq!(s.body, "Body");
    }

    #[test]
    fn ignores_unknown_fields_and_keeps_scalar_metadata_only() {
        let s = parse_skill(
            &skill(
                "name: x\ndescription: d\ndisable-model-invocation: true\n\
                 metadata:\n  tags: [a, b]\n  n: 3",
                "",
            ),
            "x",
        );
        assert_eq!(s.error, None);
        assert_eq!(s.metadata.get("n").map(String::as_str), Some("3"));
        assert!(!s.metadata.contains_key("tags"));
        assert_eq!(s.warnings.len(), 1);
    }

    #[test]
    fn a_horizontal_rule_in_the_body_is_not_the_closing_fence() {
        let s = parse_skill(&skill("name: x\ndescription: d", "one\n---\ntwo"), "x");
        assert_eq!(s.body, "one\n---\ntwo");
    }
}
