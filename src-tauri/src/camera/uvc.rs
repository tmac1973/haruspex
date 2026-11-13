//! UVC pan/tilt on Linux: `V4L2_CID_PAN_ABSOLUTE` and `V4L2_CID_TILT_ABSOLUTE`
//! on the webcam's `/dev/videoN`, in arc-seconds. Zoom is left alone.
//!
//! The last position set on each device is kept in memory and moved from,
//! because some kernels read back a stale value right after a set.

use super::aim::{uvc_axis_target, AxisRange, CameraAimResult};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use v4l::control::{Control, Value};

/// `V4L2_CID_CAMERA_CLASS_BASE` + 8 and + 9.
const PAN_ABSOLUTE: u32 = 0x009a_0908;
const TILT_ABSOLUTE: u32 = 0x009a_0909;

/// The (pan, tilt) last set on each device, by path.
static LAST_SET: LazyLock<Mutex<HashMap<String, (i64, i64)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct Axes {
    pan: Option<AxisRange>,
    tilt: Option<AxisRange>,
}

/// The webcam's pan and tilt ranges. v4l unwraps a control's name and type,
/// so a webcam that reports one it can't read counts as having neither.
fn axes(device: &v4l::Device) -> Axes {
    let controls =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| device.query_controls()))
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
    let range = |id: u32| {
        controls.iter().find(|c| c.id == id).map(|c| AxisRange {
            min: c.minimum,
            max: c.maximum,
            step: i64::try_from(c.step).unwrap_or(1),
        })
    };
    Axes {
        pan: range(PAN_ABSOLUTE),
        tilt: range(TILT_ABSOLUTE),
    }
}

fn open(path: &str) -> Result<v4l::Device, String> {
    v4l::Device::with_path(path).map_err(|e| format!("Couldn't open {path}: {e}"))
}

/// Whether the webcam at `path` can pan or tilt.
pub(crate) fn supported(path: &str) -> bool {
    open(path)
        .map(|d| {
            let a = axes(&d);
            a.pan.is_some() || a.tilt.is_some()
        })
        .unwrap_or(false)
}

/// Turn the webcam by (pan, tilt) degrees, or to the middle for `None`.
pub(crate) fn aim(path: &str, turn: Option<(f64, f64)>) -> Result<CameraAimResult, String> {
    let device = open(path)?;
    let Axes { pan, tilt } = axes(&device);
    if pan.is_none() && tilt.is_none() {
        return Err("This webcam has no pan/tilt.".into());
    }
    let (pan_deg, tilt_deg) = match turn {
        Some((p, t)) => (Some(p), Some(t)),
        None => (None, None),
    };
    if pan.is_none() && pan_deg.is_some_and(|d| d != 0.0) {
        return Err("This webcam can't turn left or right.".into());
    }
    if tilt.is_none() && tilt_deg.is_some_and(|d| d != 0.0) {
        return Err("This webcam can't tilt up or down.".into());
    }
    let remembered = LAST_SET.lock().ok().and_then(|m| m.get(path).copied());
    let current = |id: u32, last: Option<i64>| {
        last.or_else(|| match device.control(id).ok()?.value {
            Value::Integer(v) => Some(v),
            _ => None,
        })
        .unwrap_or(0)
    };
    let mut at_limit = false;
    let mut set = |id: u32, range: Option<AxisRange>, degrees: Option<f64>, last: Option<i64>| {
        let Some(range) = range else {
            return Ok(last.unwrap_or(0));
        };
        let now = current(id, last);
        if degrees == Some(0.0) {
            return Ok(now);
        }
        let (target, short) = uvc_axis_target(range, now, degrees);
        at_limit |= short;
        device
            .set_control(Control {
                id,
                value: Value::Integer(target),
            })
            .map_err(|e| format!("The webcam refused to move: {e}"))?;
        Ok::<i64, String>(target)
    };
    let pan_at = set(PAN_ABSOLUTE, pan, pan_deg, remembered.map(|r| r.0))?;
    let tilt_at = set(TILT_ABSOLUTE, tilt, tilt_deg, remembered.map(|r| r.1))?;
    if let Ok(mut m) = LAST_SET.lock() {
        m.insert(path.to_string(), (pan_at, tilt_at));
    }
    Ok(CameraAimResult {
        at_limit,
        unmoved: false,
    })
}
