//! ONVIF pan/tilt: continuous moves, stop, presets and home. Zoom is left
//! alone. Used by `camera_look` (phase 06) through [`Ptz`].

use super::soap::{self, Element};
use super::Client;
use crate::camera::{Credentials, OnvifEndpoint, OnvifPreset};
use std::time::Duration;

/// The longest a [`Ptz::move_by`] runs before it stops.
#[allow(dead_code, reason = "camera_look (phase 06) moves cameras")]
pub(crate) const MAX_MOVE: Duration = Duration::from_secs(10);

/// Where the camera points and whether it is moving, as far as it says.
#[allow(dead_code, reason = "camera_look (phase 06) reads it")]
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PtzStatus {
    /// Normalized, -1 to 1, when the camera reports its position.
    pub pan: Option<f32>,
    pub tilt: Option<f32>,
    /// `None` when the camera doesn't say.
    pub moving: Option<bool>,
}

/// A camera's pan/tilt service, opened once and called as often as needed.
pub(crate) struct Ptz {
    client: Client,
    url: String,
    profile: String,
}

#[allow(dead_code, reason = "camera_look (phase 06) moves cameras")]
impl Ptz {
    /// Open the PTZ service of the camera at `endpoint` (its clock read, its
    /// PTZ address looked up). Errors are redacted.
    pub async fn open(endpoint: &OnvifEndpoint, creds: Credentials) -> Result<Self, String> {
        let client = Client::new(&endpoint.xaddr, creds).await?;
        let url = client
            .services()
            .await?
            .ptz
            .ok_or("This camera has no ONVIF pan/tilt.")?;
        Ok(Self {
            client,
            url,
            profile: endpoint.profile_token.clone(),
        })
    }

    /// Start moving at normalized velocities (-1 to 1; positive pan is right,
    /// positive tilt is up) until [`Ptz::stop`].
    pub async fn continuous_move(&self, pan: f32, tilt: f32) -> Result<(), String> {
        let body = continuous_move_body(&self.profile, pan, tilt)?;
        self.client.call(&self.url, &body).await.map(drop)
    }

    /// Stop panning and tilting.
    pub async fn stop(&self) -> Result<(), String> {
        let body = stop_body(&self.profile);
        self.client.call(&self.url, &body).await.map(drop)
    }

    /// Move at `pan`/`tilt` for `duration` (at most [`MAX_MOVE`]), then stop.
    pub async fn move_by(&self, pan: f32, tilt: f32, duration: Duration) -> Result<(), String> {
        self.continuous_move(pan, tilt).await?;
        tokio::time::sleep(duration.min(MAX_MOVE)).await;
        self.stop().await
    }

    pub async fn goto_preset(&self, token: &str) -> Result<(), String> {
        let body = format!(
            "<tptz:GotoPreset>{}<tptz:PresetToken>{}</tptz:PresetToken></tptz:GotoPreset>",
            profile_element(&self.profile),
            soap::escape(token)
        );
        self.client.call(&self.url, &body).await.map(drop)
    }

    pub async fn goto_home(&self) -> Result<(), String> {
        let body = format!(
            "<tptz:GotoHomePosition>{}</tptz:GotoHomePosition>",
            profile_element(&self.profile)
        );
        self.client.call(&self.url, &body).await.map(drop)
    }

    pub async fn status(&self) -> Result<PtzStatus, String> {
        let body = format!(
            "<tptz:GetStatus>{}</tptz:GetStatus>",
            profile_element(&self.profile)
        );
        Ok(parse_status(&self.client.call(&self.url, &body).await?))
    }

    pub async fn presets(&self) -> Result<Vec<OnvifPreset>, String> {
        presets_at(&self.client, &self.url, &self.profile).await
    }
}

/// The presets saved on `profile`.
pub(crate) async fn presets_at(
    client: &Client,
    url: &str,
    profile: &str,
) -> Result<Vec<OnvifPreset>, String> {
    let body = format!(
        "<tptz:GetPresets>{}</tptz:GetPresets>",
        profile_element(profile)
    );
    Ok(parse_presets(&client.call(url, &body).await?))
}

fn profile_element(profile: &str) -> String {
    format!(
        "<tptz:ProfileToken>{}</tptz:ProfileToken>",
        soap::escape(profile)
    )
}

pub(crate) fn continuous_move_body(profile: &str, pan: f32, tilt: f32) -> Result<String, String> {
    if !pan.is_finite() || !tilt.is_finite() {
        return Err("Pan and tilt speeds must be numbers.".into());
    }
    let (pan, tilt) = (pan.clamp(-1.0, 1.0), tilt.clamp(-1.0, 1.0));
    Ok(format!(
        concat!(
            "<tptz:ContinuousMove>{}<tptz:Velocity>",
            r#"<tt:PanTilt x="{:.3}" y="{:.3}"/>"#,
            "</tptz:Velocity></tptz:ContinuousMove>"
        ),
        profile_element(profile),
        pan,
        tilt
    ))
}

pub(crate) fn stop_body(profile: &str) -> String {
    format!(
        "<tptz:Stop>{}<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>false</tptz:Zoom></tptz:Stop>",
        profile_element(profile)
    )
}

pub(crate) fn parse_presets(reply: &Element) -> Vec<OnvifPreset> {
    reply
        .children_named("Preset")
        .filter_map(|p| {
            let token = p.attr("token")?.to_string();
            let name = p.text_at(&["Name"]).unwrap_or(&token).to_string();
            Some(OnvifPreset { token, name })
        })
        .collect()
}

pub(crate) fn parse_status(reply: &Element) -> PtzStatus {
    let status = reply.find("PTZStatus");
    let pan_tilt = status.and_then(|s| s.path(&["Position", "PanTilt"]));
    let coord = |name: &str| pan_tilt.and_then(|p| p.attr(name)?.trim().parse::<f32>().ok());
    let moving = status
        .and_then(|s| s.path(&["MoveStatus", "PanTilt"]))
        .map(|m| m.text.trim())
        .filter(|m| !m.is_empty())
        .map(|m| !m.eq_ignore_ascii_case("IDLE"));
    PtzStatus {
        pan: coord("x"),
        tilt: coord("y"),
        moving,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_of(xml: &str) -> Element {
        soap::body(&soap::parse(xml).unwrap()).unwrap().clone()
    }

    #[test]
    fn a_move_is_pan_tilt_only_and_clamped() {
        let body = continuous_move_body("Profile_0", 1.5, -0.25).unwrap();
        let root = body_of(&soap::envelope(&body, None));
        assert_eq!(root.name, "ContinuousMove");
        assert_eq!(root.text_at(&["ProfileToken"]), Some("Profile_0"));
        let pt = root.path(&["Velocity", "PanTilt"]).unwrap();
        assert_eq!(pt.attr("x"), Some("1.000"));
        assert_eq!(pt.attr("y"), Some("-0.250"));
        assert!(root.find("Zoom").is_none());
        assert!(continuous_move_body("p", f32::NAN, 0.0).is_err());
    }

    #[test]
    fn stop_leaves_zoom_alone() {
        let root = body_of(&soap::envelope(&stop_body("a&b"), None));
        assert_eq!(root.text_at(&["ProfileToken"]), Some("a&b"));
        assert_eq!(root.text_at(&["PanTilt"]), Some("true"));
        assert_eq!(root.text_at(&["Zoom"]), Some("false"));
    }

    #[test]
    fn thingino_presets_are_read() {
        let presets = parse_presets(&body_of(include_str!("fixtures/thingino_get_presets.xml")));
        assert_eq!(
            presets,
            vec![
                OnvifPreset {
                    token: "0".into(),
                    name: "Door".into()
                },
                OnvifPreset {
                    token: "1".into(),
                    name: "Window".into()
                },
            ]
        );
    }

    #[test]
    fn thingino_status_gives_the_position() {
        let status = parse_status(&body_of(include_str!("fixtures/thingino_get_status.xml")));
        assert_eq!(status.pan, Some(0.25));
        assert_eq!(status.tilt, Some(-0.5));
        assert_eq!(status.moving, Some(false));
        assert_eq!(parse_status(&Element::default()), PtzStatus::default());
    }
}
