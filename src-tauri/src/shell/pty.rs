use std::path::Path;

pub fn resolve_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() && Path::new(&s).is_file() {
            return s;
        }
    }
    "/bin/bash".to_string()
}

pub fn resolve_cwd() -> String {
    if let Ok(home) = std::env::var("HOME") {
        if Path::new(&home).is_dir() {
            return home;
        }
    }
    "/".to_string()
}
