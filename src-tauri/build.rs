fn main() {
    google_oauth_client();
    tauri_build::build()
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
