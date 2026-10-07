//! The model writing a skill: `create_skill` and `update_skill`.
//!
//! Two steps, both here so the frontend never names a path. `draft` checks the
//! request and builds the `SKILL.md` the user is shown; `save` writes the text
//! the user approved, which they may have edited, after checking it again and
//! working out the folder afresh.
//!
//! Only the user's own folder and, in Code mode, the trusted repo's are
//! written. A skill from a built-in, an extra folder or `~/.agents/skills/`
//! belongs to the app or another tool; the model can save its own copy under
//! the same name instead, which takes its place.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_norway::{Mapping, Value};

use super::discover::{self, Found};
use super::parse::{parse_skill, split_frontmatter, DESCRIPTION_MAX, NAME_MAX};
use super::SkillSource;

/// What the model asked for.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillWriteRequest {
    /// True for `update_skill`.
    pub update: bool,
    pub name: String,
    /// Required to create; when updating, None keeps the current one.
    pub description: Option<String>,
    pub body: String,
    /// Create in the trusted repo's `.agents/skills/` rather than the user's
    /// folder. Ignored when updating, which writes where the skill is.
    pub project: bool,
}

/// The `SKILL.md` to show the user before anything is written.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillDraft {
    /// The skill's folder.
    pub dir: String,
    pub text: String,
    /// The file as it is now, when updating.
    pub current: Option<String>,
}

/// Where a write lands.
struct Target {
    dir: PathBuf,
    current: Option<String>,
}

/// The folders a new skill may go in: the user's, and the trusted repo's
/// `.agents/skills/` when there is one.
pub struct Destinations<'a> {
    pub user: &'a Path,
    pub project_root: Option<&'a Path>,
}

pub fn draft(
    all: &[Found],
    dest: &Destinations,
    req: &SkillWriteRequest,
) -> Result<SkillDraft, String> {
    if req.body.trim().is_empty() {
        return Err("body is empty: give the skill's instructions".into());
    }
    let target = target(all, dest, req)?;
    let text = match &target.current {
        Some(current) => updated_text(current, req)?,
        None => new_text(req)?,
    };
    Ok(SkillDraft {
        dir: target.dir.to_string_lossy().into_owned(),
        text,
        current: target.current,
    })
}

/// Write `text` for the skill `req` names, returning the file written.
pub fn save(
    all: &[Found],
    dest: &Destinations,
    req: &SkillWriteRequest,
    text: &str,
) -> Result<PathBuf, String> {
    let target = target(all, dest, req)?;
    let folder = target
        .dir
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parsed = parse_skill(text, &folder);
    if let Some(e) = parsed.error {
        return Err(format!("the skill can't be used as written: {e}"));
    }
    if parsed.name != req.name {
        return Err(format!("the name must stay \"{}\"", req.name));
    }
    fs::create_dir_all(&target.dir).map_err(|e| e.to_string())?;
    let file = target.dir.join("SKILL.md");
    let tmp = target.dir.join(".SKILL.md.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(file)
}

fn target(all: &[Found], dest: &Destinations, req: &SkillWriteRequest) -> Result<Target, String> {
    if req.update {
        update_target(all, &req.name)
    } else {
        create_target(all, dest, &req.name, req.project)
    }
}

fn create_target(
    all: &[Found],
    dest: &Destinations,
    name: &str,
    project: bool,
) -> Result<Target, String> {
    check_name(name)?;
    let (source, root) = if project {
        let root = dest.project_root.ok_or(
            "there is no trusted repo here; leave out \"where\" to save it to the user's skills",
        )?;
        (SkillSource::Project, root.join(".agents").join("skills"))
    } else {
        (SkillSource::User, dest.user.to_path_buf())
    };
    // One the new skill wouldn't override: the same folder, or one that
    // takes precedence over it.
    if all
        .iter()
        .any(|f| f.parsed.name == name && f.source >= source)
    {
        return Err(format!(
            "a skill named \"{name}\" already exists; use update_skill to change it"
        ));
    }
    let dir = root.join(name);
    if dir.exists() {
        return Err(format!(
            "a folder named \"{name}\" is already in the skills folder; choose another name"
        ));
    }
    Ok(Target { dir, current: None })
}

fn update_target(all: &[Found], name: &str) -> Result<Target, String> {
    let skill = discover::find(all, name)
        .ok_or_else(|| format!("no skill named \"{name}\"; use create_skill to make it"))?;
    let place = match skill.source {
        SkillSource::User | SkillSource::Project => None,
        SkillSource::Builtin => Some("is built into Haruspex"),
        SkillSource::Extra => Some("is in a folder added in Settings"),
        SkillSource::Shared => Some("is in ~/.agents/skills, shared with other tools"),
    };
    if let Some(place) = place {
        return Err(format!(
            "\"{name}\" {place} and can't be changed here. Use create_skill with the same \
             name to save your own copy, which takes its place"
        ));
    }
    let dir = skill
        .dir
        .clone()
        .ok_or("a built-in skill can't be changed")?;
    // A linked-in skill lives in another tool's folder.
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!(
            "\"{name}\" is linked in from another folder and can't be changed here"
        ));
    }
    let current = fs::read_to_string(dir.join("SKILL.md")).map_err(|e| e.to_string())?;
    Ok(Target {
        dir,
        current: Some(current),
    })
}

/// The spec's name rules, enforced for a skill the model makes.
fn check_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.chars().count() <= NAME_MAX
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--");
    if valid {
        Ok(())
    } else {
        Err(format!(
            "\"{name}\" is not a valid skill name: use up to {NAME_MAX} lowercase letters, \
             digits and single hyphens, not starting or ending with a hyphen"
        ))
    }
}

fn check_description(description: &str) -> Result<&str, String> {
    let d = description.trim();
    if d.is_empty() {
        return Err("description is empty: say what the skill does and when to use it".into());
    }
    if d.chars().count() > DESCRIPTION_MAX {
        return Err(format!(
            "description is longer than {DESCRIPTION_MAX} characters"
        ));
    }
    Ok(d)
}

fn new_text(req: &SkillWriteRequest) -> Result<String, String> {
    let description = check_description(req.description.as_deref().unwrap_or(""))?;
    let mut metadata = Mapping::new();
    metadata.insert("created-by".into(), "haruspex".into());
    let mut front = Mapping::new();
    front.insert("name".into(), req.name.as_str().into());
    front.insert("description".into(), description.into());
    front.insert("metadata".into(), Value::Mapping(metadata));
    let yaml = serde_norway::to_string(&front).map_err(|e| e.to_string())?;
    Ok(skill_text(&yaml, &req.body))
}

/// `current` with its body replaced and, when given, its description. The
/// rest of the frontmatter is kept; it is rewritten only when the
/// description changes, which drops any YAML comments in it.
fn updated_text(current: &str, req: &SkillWriteRequest) -> Result<String, String> {
    let current = current.replace("\r\n", "\n");
    let (yaml, _) = split_frontmatter(current.trim_start_matches('\u{feff}'))?;
    let yaml = match &req.description {
        None => yaml.to_string(),
        Some(description) => {
            let description = check_description(description)?;
            let mut front: Mapping = serde_norway::from_str(yaml)
                .map_err(|e| format!("the current frontmatter can't be read: {e}"))?;
            front.insert("description".into(), description.into());
            serde_norway::to_string(&front).map_err(|e| e.to_string())?
        }
    };
    Ok(skill_text(&yaml, &req.body))
}

fn skill_text(yaml: &str, body: &str) -> String {
    let yaml = yaml.trim_end();
    format!("---\n{yaml}\n---\n\n{}\n", body.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::discover::Root;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_skills_write_test_{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn put(dir: &Path, front: &str, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("---\n{front}\n---\n{body}\n")).unwrap();
    }

    fn create(name: &str, description: &str, body: &str) -> SkillWriteRequest {
        SkillWriteRequest {
            update: false,
            name: name.into(),
            description: Some(description.into()),
            body: body.into(),
            project: false,
        }
    }

    fn update(name: &str, description: Option<&str>, body: &str) -> SkillWriteRequest {
        SkillWriteRequest {
            update: true,
            name: name.into(),
            description: description.map(Into::into),
            body: body.into(),
            project: false,
        }
    }

    struct Fixture {
        user: PathBuf,
        shared: PathBuf,
        repo: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let base = temp_dir(name);
            let f = Fixture {
                user: base.join("user"),
                shared: base.join("shared"),
                repo: base.join("repo"),
            };
            for d in [&f.user, &f.shared, &f.repo] {
                fs::create_dir_all(d).unwrap();
            }
            f
        }

        fn all(&self) -> Vec<Found> {
            let roots = [
                Root {
                    source: SkillSource::Shared,
                    dir: self.shared.clone(),
                },
                Root {
                    source: SkillSource::User,
                    dir: self.user.clone(),
                },
                Root {
                    source: SkillSource::Project,
                    dir: self.repo.join(".agents/skills"),
                },
            ];
            discover::discover(&roots, &[])
        }

        fn dest(&self) -> Destinations<'_> {
            Destinations {
                user: &self.user,
                project_root: Some(&self.repo),
            }
        }
    }

    #[test]
    fn drafts_and_saves_a_new_skill_labelled_as_the_models() {
        let f = Fixture::new("create");
        let req = create(
            "deploy-check",
            "Check a deploy: run when asked to.",
            "Run the checks.",
        );
        let draft = draft(&f.all(), &f.dest(), &req).unwrap();
        assert!(draft.current.is_none());
        assert_eq!(draft.dir, f.user.join("deploy-check").to_string_lossy());
        let parsed = parse_skill(&draft.text, "deploy-check");
        assert_eq!(parsed.error, None);
        assert_eq!(parsed.description, "Check a deploy: run when asked to.");
        assert_eq!(
            parsed.metadata.get("created-by").map(String::as_str),
            Some("haruspex")
        );
        assert_eq!(parsed.body, "Run the checks.");

        let edited = draft
            .text
            .replace("Run the checks.", "Run the checks twice.");
        let file = save(&f.all(), &f.dest(), &req, &edited).unwrap();
        assert_eq!(fs::read_to_string(file).unwrap(), edited);
        assert!(!f.user.join("deploy-check/.SKILL.md.tmp").exists());
    }

    #[test]
    fn turns_back_bad_requests() {
        let f = Fixture::new("bad");
        let all = f.all();
        let long = "x".repeat(65);
        for name in ["Deploy", "-x", "x-", "a--b", "", "a b", " x", long.as_str()] {
            let err = draft(&all, &f.dest(), &create(name, "d", "b")).unwrap_err();
            assert!(err.contains("not a valid skill name"), "{name}: {err}");
        }
        let err = draft(&all, &f.dest(), &create("x", "  ", "b")).unwrap_err();
        assert!(err.contains("description is empty"));
        let err = draft(&all, &f.dest(), &create("x", "d", " ")).unwrap_err();
        assert!(err.contains("body is empty"));
    }

    #[test]
    fn create_refuses_a_name_in_use_but_may_override_a_shared_skill() {
        let f = Fixture::new("collide");
        put(&f.user.join("mine"), "name: mine\ndescription: d", "b");
        put(
            &f.shared.join("borrowed"),
            "name: borrowed\ndescription: d",
            "b",
        );
        let all = f.all();
        let err = draft(&all, &f.dest(), &create("mine", "d", "b")).unwrap_err();
        assert!(err.contains("use update_skill"));
        assert!(draft(&all, &f.dest(), &create("borrowed", "d", "b")).is_ok());
        // A folder of that name that isn't a skill.
        fs::create_dir_all(f.user.join("stray")).unwrap();
        let err = draft(&all, &f.dest(), &create("stray", "d", "b")).unwrap_err();
        assert!(err.contains("already in the skills folder"));
    }

    #[test]
    fn creates_in_the_repo_only_when_there_is_one() {
        let f = Fixture::new("project");
        let mut req = create("repo-skill", "d", "b");
        req.project = true;
        let d = draft(&f.all(), &f.dest(), &req).unwrap();
        assert_eq!(
            d.dir,
            f.repo.join(".agents/skills/repo-skill").to_string_lossy()
        );
        let no_repo = Destinations {
            user: &f.user,
            project_root: None,
        };
        let err = draft(&f.all(), &no_repo, &req).unwrap_err();
        assert!(err.contains("no trusted repo"));
    }

    #[test]
    fn update_keeps_the_frontmatter_and_replaces_the_body() {
        let f = Fixture::new("update");
        put(
            &f.user.join("mine"),
            "name: mine\ndescription: Old.\nlicense: MIT # kept\nmetadata:\n  author: me",
            "Old body.",
        );
        let all = f.all();
        let d = draft(&all, &f.dest(), &update("mine", None, "New body.")).unwrap();
        assert!(d.current.unwrap().contains("Old body."));
        assert!(d.text.contains("license: MIT # kept"));
        assert!(d.text.ends_with("\n\nNew body.\n"));

        let d = draft(&all, &f.dest(), &update("mine", Some("New: better."), "B")).unwrap();
        let parsed = parse_skill(&d.text, "mine");
        assert_eq!(parsed.description, "New: better.");
        assert_eq!(parsed.license.as_deref(), Some("MIT"));
        assert_eq!(
            parsed.metadata.get("author").map(String::as_str),
            Some("me")
        );
        assert_eq!(parsed.metadata.get("created-by"), None);
    }

    #[test]
    fn update_refuses_skills_that_belong_elsewhere() {
        let f = Fixture::new("update_elsewhere");
        put(
            &f.shared.join("borrowed"),
            "name: borrowed\ndescription: d",
            "b",
        );
        let all = f.all();
        let err = draft(&all, &f.dest(), &update("borrowed", None, "b")).unwrap_err();
        assert!(err.contains("shared with other tools") && err.contains("create_skill"));
        let err = draft(&all, &f.dest(), &update("nothing", None, "b")).unwrap_err();
        assert!(err.contains("use create_skill"));
    }

    #[cfg(unix)]
    #[test]
    fn update_refuses_a_linked_in_skill() {
        let f = Fixture::new("update_link");
        let elsewhere = f.shared.join("../elsewhere/linked");
        put(&elsewhere, "name: linked\ndescription: d", "b");
        std::os::unix::fs::symlink(&elsewhere, f.user.join("linked")).unwrap();
        let err = draft(&f.all(), &f.dest(), &update("linked", None, "b")).unwrap_err();
        assert!(err.contains("linked in"));
    }

    #[test]
    fn save_checks_the_edited_text() {
        let f = Fixture::new("save_checks");
        let req = create("checked", "d", "b");
        let err = save(&f.all(), &f.dest(), &req, "no frontmatter").unwrap_err();
        assert!(err.contains("can't be used as written"));
        let renamed = "---\nname: other\ndescription: d\n---\nb\n";
        let err = save(&f.all(), &f.dest(), &req, renamed).unwrap_err();
        assert!(err.contains("must stay \"checked\""));
        assert!(!f.user.join("checked").exists());
    }
}
