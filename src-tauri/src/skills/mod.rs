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

mod agents_md;
mod discover;
mod origin;
mod parse;
mod shipped;
mod write;

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use discover::{Found, Root};
use write::{Destinations, SkillDraft, SkillWriteRequest};

/// Skills compiled into the app: (name, SKILL.md text). None today: the
/// skills Haruspex ships are copied into the user's folder instead
/// (`shipped`), where they can be edited and deleted. This stays for a skill
/// that must never change.
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
    /// Only for Code mode (`metadata.haruspex-mode: code`), such as `init`.
    pub code_mode_only: bool,
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
            code_mode_only: p.metadata.get("haruspex-mode").map(String::as_str) == Some("code"),
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

/// Check a `create_skill` or `update_skill` request and build the `SKILL.md`
/// to show the user. An error is the reason to give the model.
#[tauri::command]
pub async fn skill_draft(
    app: AppHandle,
    request: SkillWriteRequest,
    extra_dirs: Vec<String>,
    project_root: Option<String>,
) -> Result<SkillDraft, String> {
    let roots = roots(&app, &extra_dirs, project_root.as_deref());
    let user = user_skills_dir(&app).ok_or("the app data folder is unavailable")?;
    blocking(move || {
        let all = discover::discover(&roots, BUILTINS);
        let dest = Destinations {
            user: &user,
            project_root: project_root.as_deref().map(Path::new),
        };
        write::draft(&all, &dest, &request)
    })
    .await
}

/// Write the `SKILL.md` text the user approved for `request`, returning the
/// file's path. The folder is worked out again here rather than taken from
/// the draft.
#[tauri::command]
pub async fn skill_save(
    app: AppHandle,
    request: SkillWriteRequest,
    text: String,
    extra_dirs: Vec<String>,
    project_root: Option<String>,
) -> Result<String, String> {
    let roots = roots(&app, &extra_dirs, project_root.as_deref());
    let user = user_skills_dir(&app).ok_or("the app data folder is unavailable")?;
    blocking(move || {
        let all = discover::discover(&roots, BUILTINS);
        let dest = Destinations {
            user: &user,
            project_root: project_root.as_deref().map(Path::new),
        };
        write::save(&all, &dest, &request, &text).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

/// Where `/init` would write the repo's `AGENTS.md` for a shell in `cwd`, and
/// what is there now.
#[tauri::command]
pub async fn agents_md_draft(cwd: String) -> Result<agents_md::AgentsMdDraft, String> {
    blocking(move || agents_md::draft(Path::new(&cwd))).await
}

/// Write the `AGENTS.md` text the user approved, returning the file's path.
#[tauri::command]
pub async fn agents_md_save(cwd: String, text: String) -> Result<String, String> {
    blocking(move || {
        agents_md::save(Path::new(&cwd), &text).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

/// `<app data>/shipped-skills.json`: what was last copied in from `shipped`.
fn shipped_record(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("shipped-skills.json"))
}

/// Copy the skills this build ships into the user's folder, at startup.
/// Problems are logged; a skill that can't be copied never stops the app.
pub fn seed_shipped(app: &AppHandle) {
    let (Some(user), Some(record)) = (user_skills_dir(app), shipped_record(app)) else {
        return;
    };
    for e in shipped::seed(&user, &record, shipped::SHIPPED) {
        log::warn!("shipped skill not copied: {e}");
    }
}

/// The skills Haruspex ships, and where each stands on this machine.
#[tauri::command]
pub async fn skills_shipped(app: AppHandle) -> Result<Vec<shipped::ShippedSkill>, String> {
    let user = user_skills_dir(&app).ok_or("the app data folder is unavailable")?;
    let record = shipped_record(&app).ok_or("the app data folder is unavailable")?;
    blocking(move || Ok(shipped::status(&user, &record, shipped::SHIPPED))).await
}

/// Put back the shipped skill `name` as shipped, or with None every shipped
/// skill the user deleted.
#[tauri::command]
pub async fn skill_restore_shipped(app: AppHandle, name: Option<String>) -> Result<(), String> {
    let user = user_skills_dir(&app).ok_or("the app data folder is unavailable")?;
    let record = shipped_record(&app).ok_or("the app data folder is unavailable")?;
    blocking(move || shipped::restore(&user, &record, shipped::SHIPPED, name.as_deref())).await
}

/// What a repo would contribute to a turn, and which repo it is, so the
/// frontend knows whether there is anything to ask the user to trust — and
/// whether an earlier answer still applies.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectInstructions {
    /// Names of the skills under `.agents/skills/` and `.claude/skills/`,
    /// sorted, each once.
    pub skill_names: Vec<String>,
    /// An `AGENTS.md` (or, failing that, a `CLAUDE.md`) at the root.
    pub agents_md: bool,
    /// The `origin` remote's URL; None for a repo without one.
    pub origin: Option<String>,
}

/// The repo `cwd` is in: the nearest ancestor (or `cwd` itself) holding a
/// `.git` entry. A folder outside any repo has no project, so a shell sitting
/// in `~` doesn't treat the home directory's skills as a project's.
pub fn find_project_root(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors()
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
}

fn project_instructions(root: &Path) -> ProjectInstructions {
    let roots: Vec<Root> = [".agents", ".claude"]
        .iter()
        .map(|sub| Root {
            source: SkillSource::Project,
            dir: root.join(sub).join("skills"),
        })
        .collect();
    let mut skill_names: Vec<String> = discover::discover(&roots, &[])
        .into_iter()
        .map(|f| f.parsed.name)
        .collect();
    skill_names.sort();
    skill_names.dedup();
    let agents_md = ["AGENTS.md", "CLAUDE.md"]
        .iter()
        .any(|f| root.join(f).is_file());
    ProjectInstructions {
        skill_names,
        agents_md,
        origin: origin::origin_url(root),
    }
}

/// The repo root for a shell sitting in `cwd`, or None outside a repo.
#[tauri::command]
pub async fn skills_project_root(cwd: String) -> Result<Option<String>, String> {
    blocking(move || {
        Ok(find_project_root(Path::new(&cwd)).map(|p| p.to_string_lossy().into_owned()))
    })
    .await
}

/// The `AGENTS.md` instructions for a Code mode turn in `cwd`, inside the
/// repo at `root`. The frontend passes only a root the user trusts.
#[tauri::command]
pub async fn skills_agents_md(
    root: String,
    cwd: String,
) -> Result<Option<agents_md::AgentsMd>, String> {
    blocking(move || Ok(agents_md::read(Path::new(&root), Path::new(&cwd)))).await
}

/// What the repo at `root` has that would need the user's trust.
#[tauri::command]
pub async fn skills_project_info(root: String) -> Result<ProjectInstructions, String> {
    blocking(move || Ok(project_instructions(Path::new(&root)))).await
}

/// `<app data>/skills/`, for "Open skills folder".
#[tauri::command]
pub fn skills_user_dir(app: AppHandle) -> Result<String, String> {
    user_skills_dir(&app)
        .map(|d| d.to_string_lossy().into_owned())
        .ok_or_else(|| "the app data folder is unavailable".into())
}

/// Delete a skill from the user's own folder. Skills elsewhere belong to
/// another tool or a repo, so they are refused.
#[tauri::command]
pub async fn skill_delete_user(app: AppHandle, name: String) -> Result<(), String> {
    let dir = user_skills_dir(&app).ok_or("the app data folder is unavailable")?;
    blocking(move || delete_user_skill(&dir, &name)).await
}

fn delete_user_skill(user_dir: &Path, name: &str) -> Result<(), String> {
    let all = discover::discover(
        &[Root {
            source: SkillSource::User,
            dir: user_dir.to_path_buf(),
        }],
        &[],
    );
    let skill = all
        .iter()
        .find(|f| f.parsed.name == name)
        .ok_or_else(|| format!("no skill named \"{name}\" in the Haruspex skills folder"))?;
    let dir = skill
        .dir
        .as_ref()
        .ok_or("built-in skills can't be deleted")?;
    // A linked-in skill: remove the link, never what it points at.
    if fs::symlink_metadata(dir)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return fs::remove_file(dir).map_err(|e| e.to_string());
    }
    fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_ships_on_disk_and_only_for_code_mode() {
        let base = temp_dir("shipped_init");
        let record = base.join("shipped-skills.json");
        let user = base.join("skills");
        fs::create_dir_all(&user).unwrap();
        assert!(shipped::seed(&user, &record, shipped::SHIPPED).is_empty());
        let roots = [Root {
            source: SkillSource::User,
            dir: user,
        }];
        let all = discover::discover(&roots, BUILTINS);
        let init = SkillSummary::from(discover::find(&all, "init").expect("init"));
        assert_eq!(init.source, SkillSource::User);
        assert!(init.code_mode_only);
        let plan = SkillSummary::from(discover::find(&all, "plan-2d-game").unwrap());
        assert!(!plan.code_mode_only);
    }

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

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_skills_mod_test_{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn write_skill(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        let name = dir.file_name().unwrap().to_string_lossy();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: d\n---\n"),
        )
        .unwrap();
    }

    #[test]
    fn finds_the_repo_root_from_a_subfolder() {
        let base = temp_dir("root");
        fs::create_dir_all(base.join("repo/.git")).unwrap();
        fs::create_dir_all(base.join("repo/src/deep")).unwrap();
        assert_eq!(
            find_project_root(&base.join("repo/src/deep")),
            Some(base.join("repo"))
        );
        // A worktree's .git is a file, not a folder.
        fs::create_dir_all(base.join("wt/src")).unwrap();
        fs::write(base.join("wt/.git"), "gitdir: elsewhere").unwrap();
        assert_eq!(
            find_project_root(&base.join("wt/src")),
            Some(base.join("wt"))
        );
        fs::create_dir_all(base.join("plain")).unwrap();
        assert_eq!(find_project_root(&base.join("plain")), None);
    }

    #[test]
    fn reports_what_a_repo_would_contribute() {
        let base = temp_dir("info");
        let info = project_instructions(&base);
        assert!(info.skill_names.is_empty() && !info.agents_md && info.origin.is_none());
        write_skill(&base.join(".claude/skills/b"));
        write_skill(&base.join(".agents/skills/a"));
        // The same name in both folders is one skill.
        write_skill(&base.join(".claude/skills/a"));
        fs::write(base.join("CLAUDE.md"), "x").unwrap();
        fs::create_dir_all(base.join(".git")).unwrap();
        fs::write(base.join(".git/config"), "[remote \"origin\"]\n\turl = u\n").unwrap();
        let info = project_instructions(&base);
        assert_eq!(info.skill_names, vec!["a", "b"]);
        assert!(info.agents_md);
        assert_eq!(info.origin.as_deref(), Some("u"));
    }

    #[test]
    fn deletes_only_from_the_user_folder() {
        let base = temp_dir("delete");
        let user = base.join("user");
        write_skill(&user.join("mine"));
        delete_user_skill(&user, "mine").unwrap();
        assert!(!user.join("mine").exists());
        assert!(delete_user_skill(&user, "mine")
            .unwrap_err()
            .contains("no skill"));
    }

    #[cfg(unix)]
    #[test]
    fn deleting_a_linked_skill_removes_only_the_link() {
        let base = temp_dir("delete_link");
        let (user, elsewhere) = (base.join("user"), base.join("elsewhere/linked"));
        write_skill(&elsewhere);
        fs::create_dir_all(&user).unwrap();
        std::os::unix::fs::symlink(&elsewhere, user.join("linked")).unwrap();
        delete_user_skill(&user, "linked").unwrap();
        assert!(!user.join("linked").exists());
        assert!(elsewhere.join("SKILL.md").exists());
    }
}
