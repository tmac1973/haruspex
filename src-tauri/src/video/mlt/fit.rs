//! A clip's fit as MLT's `crop` filter, the same in Shotcut and Kdenlive
//! projects: each editor adds its own tag so it lists the filter as its Crop
//! effect.
//!
//! `use_profile=1` puts the edges in profile pixels, which MLT scales to the
//! source's size, so the source's own size is never needed. `Fill` is
//! `center=1`: MLT crops to the profile's shape around the centre.

use crate::video::timeline::Fit;

/// The filter's properties for a fit, or `None` for letterbox (no filter).
pub fn properties(fit: Fit, width: u32, height: u32) -> Option<Vec<(&'static str, String)>> {
    let (w, h) = (width as f64, height as f64);
    let (left, right, top, bottom, center) = match fit {
        Fit::Letterbox => return None,
        Fit::Fill => (0.0, 0.0, 0.0, 0.0, 1),
        Fit::Crop { x, y, w: cw, h: ch } => {
            (x * w, (1.0 - x - cw) * w, y * h, (1.0 - y - ch) * h, 0)
        }
    };
    let px = |v: f64| (v.max(0.0).round() as i64).to_string();
    Some(vec![
        ("mlt_service", "crop".to_string()),
        ("center", center.to_string()),
        ("center_bias", "0".to_string()),
        ("top", px(top)),
        ("bottom", px(bottom)),
        ("left", px(left)),
        ("right", px(right)),
        ("use_profile", "1".to_string()),
    ])
}

/// The fit a crop filter sets, from its properties; `None` when it crops
/// nothing (letterbox).
pub fn read(prop: impl Fn(&str) -> Option<String>, width: u32, height: u32) -> Option<Fit> {
    let num = |k: &str| {
        prop(k)
            .and_then(|v| v.trim().parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    if num("center") != 0.0 {
        return Some(Fit::Fill);
    }
    let (w, h) = (width.max(1) as f64, height.max(1) as f64);
    let (left, right, top, bottom) = (num("left"), num("right"), num("top"), num("bottom"));
    if left + right + top + bottom == 0.0 {
        return None;
    }
    let round = |v: f64| (v * 10_000.0).round() / 10_000.0;
    Some(Fit::Crop {
        x: round(left / w),
        y: round(top / h),
        w: round((w - left - right) / w),
        h: round((h - top - bottom) / h),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn back(fit: Fit) -> Option<Fit> {
        let props = properties(fit, 1920, 1080)?;
        read(
            |k| {
                props
                    .iter()
                    .find(|(pk, _)| *pk == k)
                    .map(|(_, v)| v.clone())
            },
            1920,
            1080,
        )
    }

    #[test]
    fn letterbox_writes_nothing() {
        assert!(properties(Fit::Letterbox, 1920, 1080).is_none());
    }

    #[test]
    fn fill_and_crops_read_back() {
        assert_eq!(back(Fit::Fill), Some(Fit::Fill));
        let crop = Fit::Crop {
            x: 0.25,
            y: 0.1,
            w: 0.5,
            h: 0.8,
        };
        assert_eq!(back(crop), Some(crop));
    }

    #[test]
    fn a_crop_is_in_profile_pixels() {
        let props = properties(
            Fit::Crop {
                x: 0.25,
                y: 0.0,
                w: 0.5,
                h: 1.0,
            },
            1280,
            720,
        )
        .unwrap();
        let get = |k: &str| props.iter().find(|(p, _)| *p == k).unwrap().1.clone();
        assert_eq!(get("left"), "320");
        assert_eq!(get("right"), "320");
        assert_eq!(get("top"), "0");
        assert_eq!(get("use_profile"), "1");
    }

    #[test]
    fn crop_regions_are_checked() {
        assert!(Fit::Crop {
            x: 0.6,
            y: 0.0,
            w: 0.5,
            h: 1.0
        }
        .problem()
        .is_some());
        assert!(Fit::Crop {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 1.0
        }
        .problem()
        .is_some());
        assert!(Fit::Fill.problem().is_none());
    }
}
