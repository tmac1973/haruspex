//! Agent Skills (agentskills.io): folders holding a `SKILL.md` whose YAML
//! frontmatter names and describes the skill, and whose body tells the model
//! how to do something.
//!
//! This module finds them, parses them leniently and serves them to every
//! window. Whether a skill reaches a turn — enabled, trusted, autonomous use
//! on — is the frontend's business; it passes in only the folders it wants
//! searched (`extra_dirs`, and `project_root` only for a repo the user
//! trusts).
//!
//! Sources, lowest precedence first (`SkillSource` order):
//!   built-in → extra folders from Settings → `~/.agents/skills/` →
//!   `<app data>/skills/` → the project's `.agents/skills/` and
//!   `.claude/skills/`.
//! Project overrides user, the convention every client follows; Haruspex's
//! own folder overrides folders shared with other tools.

mod discover;
mod parse;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use discover::{Found, Root};

/// Skills shipped in the app: (name, SKILL.md text).
const BUILTINS: &[(&str, &str)] = &[];

/// Where a skill came from. Declaration order is precedence order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SkillSource {
    Builtin,
    /// A folder the user added in Settings.
    Extra,
    /// `~/.agents/skills/`, shared with other tools.
    Shared,
    /// `<app data>/skills/`, Haruspex's own.
    User,
    /// The trusted repo's `.agents/skills/` or `.claude/skills/`.
    Project,
}

/// One skill as Settings and the autocomplete see it.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub source: SkillSource,
    /// The skill's folder; None for a built-in.
    pub dir: Option<String>,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub allowed_tools: Option<String>,
    /// Problems that leave the skill usable.
    pub warnings: Vec<String>,
    /// Why the skill can't be used. Such a skill is listed, never offered.
    pub error: Option<String>,
    /// A higher-precedence skill has the same name.
    pub shadowed: bool,
    /// Written by Haruspex's model (`metadata.created-by: haruspex`).
    pub created_by_model: bool,
}

/// A skill's instructions, as loaded into a turn.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillDoc {
    pub name: String,
    pub body: String,
    pub dir: Option<String>,
    pub compatibility: Option<String>,
    /// Other files in the skill's folder, `/`-separated and relative to it.
    pub files: Vec<String>,
    /// The file list stopped at its cap.
    pub files_truncated: bool,
}

impl From<&Found> for SkillSummary {
    fn from(f: &Found) -> Self {
        let p = &f.parsed;
        SkillSummary {
            name: p.name.clone(),
            description: p.description.clone(),
            source: f.source,
            dir: f.dir.as_ref().map(|d| d.to_string_lossy().into_owned()),
            license: p.license.clone(),
            compatibility: p.compatibility.clone(),
            allowed_tools: p.allowed_tools.clone(),
            warnings: p.warnings.clone(),
            error: p.error.clone(),
            shadowed: f.shadowed,
            created_by_model: p.metadata.get("created-by").map(String::as_str) == Some("haruspex"),
        }
    }
}

/// `~` and `~/…` against the home directory.
fn expand_home(path: &str, home: Option<&PathBuf>) -> PathBuf {
    match (path.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            home.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(path),
    }
}

/// The folders to search, lowest precedence first.
fn roots(app: &AppHandle, extra_dirs: &[String], project_root: Option<&str>) -> Vec<Root> {
    let home = app.path().home_dir().ok();
    let mut roots: Vec<Root> = extra_dirs
        .iter()
        .filter(|d| !d.trim().is_empty())
        .map(|d| Root {
            source: SkillSource::Extra,
            dir: expand_home(d.trim(), home.as_ref()),
        })
        .collect();
    if let Some(home) = &home {
        roots.push(Root {
            source: SkillSource::Shared,
            dir: home.join(".agents").join("skills"),
        });
    }
    if let Some(dir) = user_skills_dir(app) {
        roots.push(Root {
            source: SkillSource::User,
            dir,
        });
    }
    if let Some(project) = project_root.filter(|p| !p.trim().is_empty()) {
        let project = PathBuf::from(project);
        for sub in [".agents", ".claude"] {
            roots.push(Root {
                source: SkillSource::Project,
                dir: project.join(sub).join("skills"),
            });
        }
    }
    roots
}

/// `<app data>/skills/`, created so "Open skills folder" always has
/// somewhere to go.
fn user_skills_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("skills");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Every skill in the folders searched, including unusable and shadowed ones,
/// sorted by name.
#[tauri::command]
pub async fn skills_list(
    app: AppHandle,
    extra_dirs: Vec<String>,
    project_root: Option<String>,
) -> Result<Vec<SkillSummary>, String> {
    let roots = roots(&app, &extra_dirs, project_root.as_deref());
    blocking(move || {
        Ok(discover::discover(&roots, BUILTINS)
            .iter()
            .map(SkillSummary::from)
            .collect())
    })
    .await
}

/// The instructions of the skill `name` means, read fresh from disk.
#[tauri::command]
pub async fn skill_read(
    app: AppHandle,
    name: String,
    extra_dirs: Vec<String>,
    project_root: Option<String>,
) -> Result<SkillDoc, String> {
    let roots = roots(&app, &extra_dirs, project_root.as_deref());
    blocking(move || {
        let all = discover::discover(&roots, BUILTINS);
        let skill =
            discover::find(&all, &name).ok_or_else(|| format!("no skill named \"{name}\""))?;
        let (files, files_truncated) = skill
            .dir
            .as_deref()
            .map(discover::list_files)
            .unwrap_or_default();
        Ok(SkillDoc {
            name: skill.parsed.name.clone(),
            body: skill.parsed.body.clone(),
            dir: skill.dir.as_ref().map(|d| d.to_string_lossy().into_owned()),
            compatibility: skill.parsed.compatibility.clone(),
            files,
            files_truncated,
        })
    })
    .await
}

/// One file from inside the skill `name`'s folder.
#[tauri::command]
pub async fn skill_read_file(
    app: AppHandle,
    name: String,
    path: String,
    extra_dirs: Vec<String>,
    project_root: Option<String>,
) -> Result<String, String> {
    let roots = roots(&app, &extra_dirs, project_root.as_deref());
    blocking(move || {
        let all = discover::discover(&roots, BUILTINS);
        let skill =
            discover::find(&all, &name).ok_or_else(|| format!("no skill named \"{name}\""))?;
        let dir = skill
            .dir
            .as_deref()
            .ok_or_else(|| format!("\"{name}\" is built in and has no other files"))?;
        discover::read_file(dir, &path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home() {
        let home = PathBuf::from("/home/u");
        assert_eq!(expand_home("~", Some(&home)), home);
        assert_eq!(
            expand_home("~/.claude/skills", Some(&home)),
            home.join(".claude/skills")
        );
        assert_eq!(
            expand_home("~other/x", Some(&home)),
            PathBuf::from("~other/x")
        );
        assert_eq!(expand_home("/abs", Some(&home)), PathBuf::from("/abs"));
        assert_eq!(expand_home("~/x", None), PathBuf::from("~/x"));
    }

    #[test]
    fn precedence_follows_declaration_order() {
        use SkillSource::*;
        assert!(Builtin < Extra && Extra < Shared && Shared < User && User < Project);
    }

    #[test]
    fn summary_flags_model_written_skills() {
        let mut parsed = parse::parse_skill(
            "---\nname: x\ndescription: d\nmetadata:\n  created-by: haruspex\n---\n",
            "x",
        );
        parsed.body.clear();
        let found = Found {
            source: SkillSource::User,
            dir: None,
            parsed,
            shadowed: false,
        };
        assert!(SkillSummary::from(&found).created_by_model);
    }
}
