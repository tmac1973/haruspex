fn main() {
    google_oauth_client();
    shipped_skills();
    tauri_build::build()
}

/// Compile in the skills under `resources/skills/`, which `skills::shipped`
/// copies into the user's skills folder. Embedded rather than bundled as
/// resources, so dev and every installer find them the same way.
///
/// Writes `$OUT_DIR/shipped_skills.rs`: `SHIPPED`, each file's path relative
/// to `resources/skills/` and its bytes, sorted by path.
fn shipped_skills() {
    use std::path::{Path, PathBuf};
    let root = Path::new("resources/skills");
    println!("cargo:rerun-if-changed={}", root.display());
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(root, &mut files);
    files.sort();
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let mut code = String::from("pub const SHIPPED: &[(&str, &[u8])] = &[\n");
    for file in &files {
        let rel = file
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let abs = Path::new(&manifest).join(file);
        code.push_str(&format!(
            "    ({rel:?}, include_bytes!({:?})),\n",
            abs.to_string_lossy()
        ));
    }
    code.push_str("];\n");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("shipped_skills.rs");
    std::fs::write(out, code).unwrap();
}

/// Compile in Haruspex's Google OAuth desktop client, when this checkout has
/// one (`google-oauth.json`, gitignored — see `docs/google-sign-in.md`).
///
/// Without it the build still works; "Sign in with Google" is just not
/// offered. The file is watched only once it exists: a `rerun-if-changed` on a
/// missing path reruns this script on every build, so after adding the file
/// for the first time, touch this one.
fn google_oauth_client() {
    let path = "google-oauth.json";
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    println!("cargo:rerun-if-changed={path}");
    let json: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path} is not valid JSON: {e}"));
    for (field, var) in [
        ("clientId", "HARUSPEX_GOOGLE_CLIENT_ID"),
        ("clientSecret", "HARUSPEX_GOOGLE_CLIENT_SECRET"),
    ] {
        let value = json
            .get(field)
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("{path} has no \"{field}\""));
        println!("cargo:rustc-env={var}={value}");
    }
}
