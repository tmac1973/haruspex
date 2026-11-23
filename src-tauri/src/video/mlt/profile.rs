//! The Settings → Video presets as MLT profiles, which both editors' projects
//! carry as a `<profile>` element.

/// A preset's MLT profile.
pub struct Profile {
    pub name: &'static str,
    pub description: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

pub fn profile(preset: &str) -> Result<Profile, String> {
    let p = match preset {
        "720p24" => Profile {
            name: "atsc_720p_24",
            description: "HD 720p 24 fps",
            width: 1280,
            height: 720,
            fps: 24,
        },
        "1080p30" => Profile {
            name: "atsc_1080p_30",
            description: "HD 1080p 30 fps",
            width: 1920,
            height: 1080,
            fps: 30,
        },
        "1080p60" => Profile {
            name: "atsc_1080p_60",
            description: "HD 1080p 60 fps",
            width: 1920,
            height: 1080,
            fps: 60,
        },
        "1440p60" => Profile {
            name: "qhd_1440p_60",
            description: "2.5K QHD 1440p 60 fps",
            width: 2560,
            height: 1440,
            fps: 60,
        },
        "2160p30" => Profile {
            name: "uhd_2160p_30",
            description: "4K UHD 2160p 30 fps",
            width: 3840,
            height: 2160,
            fps: 30,
        },
        other => {
            return Err(format!(
                "Unknown format {other}: use 720p24, 1080p30, 1080p60, 1440p60 or 2160p30."
            ))
        }
    };
    Ok(p)
}

pub fn profile_tag(p: &Profile) -> String {
    format!(
        "<profile colorspace=\"709\" description=\"{}\" display_aspect_den=\"9\" display_aspect_num=\"16\" \
         frame_rate_den=\"1\" frame_rate_num=\"{}\" height=\"{}\" progressive=\"1\" sample_aspect_den=\"1\" \
         sample_aspect_num=\"1\" width=\"{}\"/>",
        p.description, p.fps, p.height, p.width
    )
}
