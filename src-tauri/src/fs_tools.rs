use std::path::{Path, PathBuf};

/// Resolve a relative path within a working directory, ensuring the result
/// does not escape the working directory via `..`, absolute paths, or
/// symlinks.
///
/// The relative path may refer to a file that does not yet exist (for write
/// operations). In that case, the parent directory must exist and be inside
/// the working dir — the resolved path is `canonical_parent/filename`.
///
/// Returns an error if:
///   - `workdir` itself cannot be canonicalized
///   - The resolved path escapes the working directory
///   - The path is otherwise malformed
#[allow(dead_code)] // used starting in step 5
pub fn resolve_in_workdir(workdir: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if rel_path.is_empty() || rel_path == "." {
        return workdir
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize working directory: {}", e));
    }

    let workdir_canonical = workdir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize working directory: {}", e))?;

    // Treat the relative path as relative to the working dir even if it
    // starts with "/" — we reject absolute paths that would escape.
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        // Allow absolute paths only if they already point inside the workdir.
        let canonical = rel
            .canonicalize()
            .or_else(|_| resolve_nonexistent(rel))?;
        if !canonical.starts_with(&workdir_canonical) {
            return Err("path escapes working directory".to_string());
        }
        return Ok(canonical);
    }

    let candidate = workdir_canonical.join(rel);
    let canonical = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize path: {}", e))?
    } else {
        // For write operations: canonicalize the parent, then append the
        // file name. This prevents symlink escape via a non-existent target.
        resolve_nonexistent(&candidate)?
    };

    if !canonical.starts_with(&workdir_canonical) {
        return Err("path escapes working directory".to_string());
    }

    Ok(canonical)
}

/// Resolve a path whose final component may not exist yet by canonicalizing
/// the parent directory (which must exist) and appending the file name.
fn resolve_nonexistent(candidate: &Path) -> Result<PathBuf, String> {
    let parent = candidate
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("Parent directory does not exist: {}", e))?;
    Ok(parent_canonical.join(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_fs_test_{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolves_simple_relative_path() {
        let dir = make_temp_dir("simple");
        fs::write(dir.join("hello.txt"), "hi").unwrap();

        let result = resolve_in_workdir(&dir, "hello.txt").unwrap();
        assert!(result.ends_with("hello.txt"));
        assert!(result.starts_with(dir.canonicalize().unwrap()));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_nested_path() {
        let dir = make_temp_dir("nested");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/file.txt"), "x").unwrap();

        let result = resolve_in_workdir(&dir, "sub/file.txt").unwrap();
        assert!(result.ends_with("file.txt"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_nonexistent_file_for_write() {
        let dir = make_temp_dir("write");
        let result = resolve_in_workdir(&dir, "new_file.txt").unwrap();
        assert!(result.ends_with("new_file.txt"));
        assert!(result.starts_with(dir.canonicalize().unwrap()));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_parent_dir_escape() {
        let dir = make_temp_dir("escape");
        let result = resolve_in_workdir(&dir, "../escaped.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("escapes"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_deep_parent_dir_escape() {
        let dir = make_temp_dir("deep_escape");
        let result = resolve_in_workdir(&dir, "sub/../../escaped.txt");
        assert!(result.is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_absolute_path_outside() {
        let dir = make_temp_dir("abs");
        let result = resolve_in_workdir(&dir, "/etc/passwd");
        assert!(result.is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_nonexistent_parent() {
        let dir = make_temp_dir("nonparent");
        let result = resolve_in_workdir(&dir, "does/not/exist/file.txt");
        assert!(result.is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_path_returns_workdir() {
        let dir = make_temp_dir("empty");
        let result = resolve_in_workdir(&dir, "").unwrap();
        assert_eq!(result, dir.canonicalize().unwrap());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dot_path_returns_workdir() {
        let dir = make_temp_dir("dot");
        let result = resolve_in_workdir(&dir, ".").unwrap();
        assert_eq!(result, dir.canonicalize().unwrap());

        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let dir = make_temp_dir("symlink");
        let outside = std::env::temp_dir().join("haruspex_fs_test_outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();

        // Create a symlink inside the workdir that points outside
        symlink(&outside, dir.join("link")).unwrap();

        // Attempting to read through the symlink should fail
        let result = resolve_in_workdir(&dir, "link/secret.txt");
        assert!(result.is_err(), "symlink escape was not caught");

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
