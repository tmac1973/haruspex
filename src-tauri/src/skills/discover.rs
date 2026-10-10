//! Finding skills on disk, deciding which of two same-named skills wins, and
//! reading a skill's files without leaving its folder.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::parse::{parse_skill, ParsedSkill};
use super::SkillSource;

/// Folders per source, so a stray huge directory can't stall a listing.
const MAX_SKILLS_PER_ROOT: usize = 2000;
/// Files listed for one skill; the listing says when it stopped short.
pub const MAX_LISTED_FILES: usize = 200;
const MAX_LIST_DEPTH: usize = 4;
/// Same budget as `fs_read_text`'s output.
const MAX_FILE_BYTES: u64 = 256 * 1024;

/// One folder skills are read from.
pub struct Root {
    pub source: SkillSource,
    pub dir: PathBuf,
}

/// A skill found on disk (or built in), parsed, with its place in precedence.
pub struct Found {
    pub source: SkillSource,
    /// The skill's folder; None for a built-in.
    pub dir: Option<PathBuf>,
    pub parsed: ParsedSkill,
    /// A higher-precedence skill has the same name.
    pub shadowed: bool,
}

/// Every skill under `roots`, plus `builtins` (name, SKILL.md text), with
/// `shadowed` set on each that a higher-precedence skill of the same name
/// overrides. Precedence is `SkillSource` order; within one source the root
/// listed first wins. Unusable skills are returned (to be shown with their
/// error) but never shadow anything.
pub fn discover(roots: &[Root], builtins: &[(&str, &str)]) -> Vec<Found> {
    let mut found: Vec<(usize, Found)> = Vec::new();
    for (name, text) in builtins {
        found.push((
            0,
            Found {
                source: SkillSource::Builtin,
                dir: None,
                parsed: parse_skill(text, name),
                shadowed: false,
            },
        ));
    }
    for (i, root) in roots.iter().enumerate() {
        for dir in skill_dirs(root) {
            let folder = dir
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default();
            let parsed = match fs::read_to_string(dir.join("SKILL.md")) {
                Ok(text) => parse_skill(&text, &folder),
                Err(e) => ParsedSkill {
                    name: folder.clone(),
                    error: Some(format!("SKILL.md could not be read: {e}")),
                    ..Default::default()
                },
            };
            found.push((
                i + 1,
                Found {
                    source: root.source,
                    dir: Some(dir),
                    parsed,
                    shadowed: false,
                },
            ));
        }
    }

    // Highest source first, then earliest root: the first usable skill seen
    // with a name is the one that name means.
    let mut order: Vec<usize> = (0..found.len()).collect();
    order.sort_by_key(|&i| (std::cmp::Reverse(found[i].1.source), found[i].0));
    let mut taken = HashSet::new();
    for i in order {
        let f = &mut found[i].1;
        if f.parsed.error.is_some() {
            continue;
        }
        if !taken.insert(f.parsed.name.clone()) {
            f.shadowed = true;
        }
    }

    let mut out: Vec<Found> = found.into_iter().map(|(_, f)| f).collect();
    out.sort_by(|a, b| {
        a.parsed
            .name
            .cmp(&b.parsed.name)
            .then(b.source.cmp(&a.source))
    });
    out
}

/// The usable, unshadowed skill called `name`.
pub fn find<'a>(all: &'a [Found], name: &str) -> Option<&'a Found> {
    all.iter()
        .find(|f| f.parsed.name == name && f.parsed.error.is_none() && !f.shadowed)
}

/// Subfolders of `root` that hold a `SKILL.md`, sorted by name.
///
/// A project's skills come from a repo that may not be the user's, so there a
/// symlink that leads out of the skills folder is skipped: it could point a
/// "skill" at any directory on the machine. The user's own folders keep their
/// symlinks, because installing a skill by linking it in is common practice.
fn skill_dirs(root: &Root) -> Vec<PathBuf> {
    // A skills folder that is itself a link (`.claude/skills` →
    // `.agents/skills`), in a WSL repo, followed inside the distro.
    let dir = crate::code_tools::wsl::follow_share_link(&root.dir);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let canon_root = dir.canonicalize().ok();
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .take(MAX_SKILLS_PER_ROOT)
        .map(|e| e.path())
        .filter(|p| p.join("SKILL.md").is_file())
        .filter(|p| {
            if root.source != SkillSource::Project {
                return true;
            }
            match (p.canonicalize(), &canon_root) {
                (Ok(real), Some(base)) => real.starts_with(base),
                _ => false,
            }
        })
        .collect();
    dirs.sort();
    dirs
}

/// Files under a skill's folder other than its `SKILL.md`, as `/`-separated
/// paths relative to it, and whether the list stopped at the cap.
pub fn list_files(dir: &Path) -> (Vec<String>, bool) {
    let mut files = Vec::new();
    let mut truncated = false;
    walk(dir, dir, 0, &mut files, &mut truncated);
    files.sort();
    (files, truncated)
}

fn walk(base: &Path, dir: &Path, depth: usize, out: &mut Vec<String>, truncated: &mut bool) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= MAX_LISTED_FILES {
            *truncated = true;
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "__pycache__" {
            continue;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if depth + 1 < MAX_LIST_DEPTH {
                walk(base, &path, depth + 1, out, truncated);
            }
        } else if let Ok(rel) = path.strip_prefix(base) {
            let rel = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if rel != "SKILL.md" {
                out.push(rel);
            }
        }
    }
}

/// The text of `rel` inside the skill folder `dir`. Refuses anything that
/// would read outside the folder: an absolute path, `..`, or a symlink that
/// leads out.
pub fn read_file(dir: &Path, rel: &str) -> Result<String, String> {
    let rel_path = Path::new(rel);
    if rel.is_empty()
        || rel_path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!(
            "\"{rel}\" is not a path inside the skill; use a relative path such as references/guide.md"
        ));
    }
    let base = dir
        .canonicalize()
        .map_err(|e| format!("the skill's folder could not be read: {e}"))?;
    let path = base
        .join(rel_path)
        .canonicalize()
        .map_err(|_| format!("the skill has no file \"{rel}\""))?;
    if !path.starts_with(&base) {
        return Err(format!("\"{rel}\" leads outside the skill's folder"));
    }
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("\"{rel}\" is a folder, not a file"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "\"{rel}\" is {} KB, over the {} KB limit for skill files",
            meta.len() / 1024,
            MAX_FILE_BYTES / 1024
        ));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| format!("\"{rel}\" is not a text file"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_skills_test_{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn write_skill(root: &Path, folder: &str, description: &str) -> PathBuf {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {folder}\ndescription: {description}\n---\nBody of {folder}\n"),
        )
        .unwrap();
        dir
    }

    fn root(source: SkillSource, dir: &Path) -> Root {
        Root {
            source,
            dir: dir.to_path_buf(),
        }
    }

    fn summary(all: &[Found]) -> Vec<(String, SkillSource, bool)> {
        all.iter()
            .map(|f| (f.parsed.name.clone(), f.source, f.shadowed))
            .collect()
    }

    #[test]
    fn project_overrides_user_and_user_overrides_builtin() {
        let base = temp_dir("precedence");
        let (user, project) = (base.join("user"), base.join("project"));
        write_skill(&user, "deploy", "user deploy");
        write_skill(&user, "notes", "user notes");
        write_skill(&project, "deploy", "project deploy");
        let builtin = "---\nname: notes\ndescription: built-in notes\n---\n";

        let all = discover(
            &[
                root(SkillSource::User, &user),
                root(SkillSource::Project, &project),
            ],
            &[("notes", builtin)],
        );
        assert_eq!(
            summary(&all),
            vec![
                ("deploy".into(), SkillSource::Project, false),
                ("deploy".into(), SkillSource::User, true),
                ("notes".into(), SkillSource::User, false),
                ("notes".into(), SkillSource::Builtin, true),
            ]
        );
        assert_eq!(
            find(&all, "deploy").unwrap().parsed.description,
            "project deploy"
        );
    }

    #[test]
    fn within_one_source_the_first_root_wins() {
        let base = temp_dir("same_source");
        let (agents, claude) = (base.join(".agents/skills"), base.join(".claude/skills"));
        write_skill(&agents, "review", "from .agents");
        write_skill(&claude, "review", "from .claude");
        let all = discover(
            &[
                root(SkillSource::Project, &agents),
                root(SkillSource::Project, &claude),
            ],
            &[],
        );
        assert_eq!(
            find(&all, "review").unwrap().parsed.description,
            "from .agents"
        );
        assert_eq!(all.iter().filter(|f| f.shadowed).count(), 1);
    }

    #[test]
    fn a_broken_skill_is_listed_but_shadows_nothing() {
        let base = temp_dir("broken");
        let (user, project) = (base.join("user"), base.join("project"));
        write_skill(&user, "lint", "works");
        let broken = project.join("lint");
        fs::create_dir_all(&broken).unwrap();
        fs::write(
            broken.join("SKILL.md"),
            "---\nname: lint\n---\nno description",
        )
        .unwrap();

        let all = discover(
            &[
                root(SkillSource::User, &user),
                root(SkillSource::Project, &project),
            ],
            &[],
        );
        assert_eq!(all.len(), 2);
        let bad = all
            .iter()
            .find(|f| f.source == SkillSource::Project)
            .unwrap();
        assert_eq!(bad.parsed.error.as_deref(), Some("no description"));
        assert_eq!(find(&all, "lint").unwrap().source, SkillSource::User);
    }

    #[test]
    fn ignores_folders_without_skill_md_and_missing_roots() {
        let base = temp_dir("non_skills");
        write_skill(&base, "real", "d");
        fs::create_dir_all(base.join("not-a-skill")).unwrap();
        fs::write(base.join("README.md"), "hi").unwrap();
        let all = discover(
            &[
                root(SkillSource::User, &base),
                root(SkillSource::Extra, &base.join("missing")),
            ],
            &[],
        );
        assert_eq!(
            summary(&all),
            vec![("real".into(), SkillSource::User, false)]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_project_symlink_leading_out_is_skipped_but_a_user_one_is_kept() {
        let base = temp_dir("symlinks");
        let elsewhere = base.join("elsewhere");
        write_skill(&elsewhere, "linked", "outside");
        let (user, project) = (base.join("user"), base.join("project"));
        fs::create_dir_all(&user).unwrap();
        fs::create_dir_all(&project).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("linked"), user.join("linked")).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("linked"), project.join("linked")).unwrap();

        let all = discover(&[root(SkillSource::Project, &project)], &[]);
        assert!(all.is_empty());
        let all = discover(&[root(SkillSource::User, &user)], &[]);
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn lists_files_without_skill_md_hidden_or_vendored_folders() {
        let base = temp_dir("list");
        let dir = write_skill(&base, "pdf", "d");
        for f in [
            "scripts/extract.py",
            "references/REFERENCE.md",
            ".git/HEAD",
            "node_modules/x/y.js",
        ] {
            let p = dir.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "x").unwrap();
        }
        let (files, truncated) = list_files(&dir);
        assert_eq!(files, vec!["references/REFERENCE.md", "scripts/extract.py"]);
        assert!(!truncated);
    }

    #[test]
    fn caps_the_file_list() {
        let base = temp_dir("list_cap");
        let dir = write_skill(&base, "big", "d");
        fs::create_dir_all(dir.join("data")).unwrap();
        for i in 0..MAX_LISTED_FILES + 5 {
            fs::write(dir.join(format!("data/{i:04}.txt")), "x").unwrap();
        }
        let (files, truncated) = list_files(&dir);
        assert_eq!(files.len(), MAX_LISTED_FILES);
        assert!(truncated);
    }

    #[test]
    fn reads_a_file_inside_the_skill() {
        let base = temp_dir("read");
        let dir = write_skill(&base, "pdf", "d");
        fs::create_dir_all(dir.join("references")).unwrap();
        fs::write(dir.join("references/guide.md"), "the guide").unwrap();
        assert_eq!(read_file(&dir, "references/guide.md").unwrap(), "the guide");
        assert_eq!(
            read_file(&dir, "./references/guide.md").unwrap(),
            "the guide"
        );
    }

    #[test]
    fn refuses_to_read_outside_the_skill() {
        let base = temp_dir("traversal");
        let dir = write_skill(&base, "pdf", "d");
        fs::write(base.join("secret.txt"), "secret").unwrap();
        assert!(read_file(&dir, "../secret.txt").is_err());
        assert!(read_file(&dir, "references/../../secret.txt").is_err());
        let abs = base.join("secret.txt").to_string_lossy().into_owned();
        assert!(read_file(&dir, &abs).is_err());
        assert!(read_file(&dir, "").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret.txt"), dir.join("link.txt")).unwrap();
            assert!(read_file(&dir, "link.txt").unwrap_err().contains("outside"));
        }
    }

    #[test]
    fn refuses_folders_binaries_and_oversized_files() {
        let base = temp_dir("read_limits");
        let dir = write_skill(&base, "pdf", "d");
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets/logo.png"), [0x89, 0x50, 0xff, 0xfe]).unwrap();
        fs::write(dir.join("big.txt"), "x".repeat(MAX_FILE_BYTES as usize + 1)).unwrap();
        assert!(read_file(&dir, "assets").unwrap_err().contains("folder"));
        assert!(read_file(&dir, "assets/logo.png")
            .unwrap_err()
            .contains("not a text file"));
        assert!(read_file(&dir, "big.txt").unwrap_err().contains("limit"));
    }
}
