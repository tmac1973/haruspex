//! The slide-deck input shape the ODP writer (`super::odp`) takes. The .pptx
//! deck is built in the frontend (`src/lib/slides/`) from the same shape, so
//! the two keep the same fields.

/// One bullet line inside a content slide. Supports two wire formats via
/// `#[serde(untagged)]`:
///
///   "First bullet"                              // level 0 (plain string)
///   { "text": "Sub bullet", "level": 1 }        // explicit level
///
/// The plain-string form keeps the common case ergonomic for the model to
/// emit; the object form is only needed when the model wants to nest.
/// Levels 0, 1, 2 are rendered; anything higher is clamped to 2.
#[derive(Clone, Debug)]
pub struct SlideBullet {
    pub text: String,
    pub level: u32,
}

impl<'de> serde::Deserialize<'de> for SlideBullet {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Plain(String),
            Structured { text: String, level: Option<u32> },
        }
        match Raw::deserialize(deserializer)? {
            Raw::Plain(text) => Ok(SlideBullet { text, level: 0 }),
            Raw::Structured { text, level } => Ok(SlideBullet {
                text,
                level: level.unwrap_or(0),
            }),
        }
    }
}

/// Slide layout selector — "content" (default) renders a title + bullet
/// body, "section" renders a single large centered title (plus optional
/// subtitle) with no content body, intended as a section divider between
/// groups of content slides.
#[derive(Clone, Debug, Default, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SlideLayout {
    #[default]
    Content,
    Section,
}

/// The deck's page shape: landscape is 16:9, portrait 9:16.
#[derive(Clone, Copy, Debug, Default, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SlideOrientation {
    #[default]
    Landscape,
    Portrait,
}

/// Data shape for a single slide. Layout, subtitle, nested bullets, and
/// image are optional so a slide that only sets a title and a flat list of
/// string bullets still works.
#[derive(serde::Deserialize)]
pub struct Slide {
    pub title: String,
    #[serde(default)]
    pub bullets: Vec<SlideBullet>,
    /// Only used when `layout = Section`. Rendered below the main title
    /// in a smaller font for an optional tagline.
    #[serde(default)]
    pub subtitle: Option<String>,
    /// Relative path (inside the working directory) to an image file to
    /// embed on this slide. Supported extensions: png, jpg, jpeg, gif.
    /// When set, the content area is split between the bullets and the
    /// image: side by side in landscape, stacked in portrait.
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub layout: SlideLayout,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_string_bullets_are_level_zero() {
        let json = r#"{"title":"T","bullets":["one","two"]}"#;
        let slide: Slide = serde_json::from_str(json).unwrap();
        assert_eq!(slide.bullets.len(), 2);
        assert_eq!(slide.bullets[1].text, "two");
        assert_eq!(slide.bullets[1].level, 0);
        assert_eq!(slide.layout, SlideLayout::Content);
    }

    #[test]
    fn structured_bullets_keep_their_level() {
        let json = r#"{"title":"T","bullets":[{"text":"a"},{"text":"b","level":2}]}"#;
        let slide: Slide = serde_json::from_str(json).unwrap();
        assert_eq!(slide.bullets[0].level, 0);
        assert_eq!(slide.bullets[1].level, 2);
    }

    #[test]
    fn layout_and_orientation_read_lowercase() {
        let slide: Slide = serde_json::from_str(r#"{"title":"T","layout":"section"}"#).unwrap();
        assert_eq!(slide.layout, SlideLayout::Section);
        let o: SlideOrientation = serde_json::from_str(r#""portrait""#).unwrap();
        assert_eq!(o, SlideOrientation::Portrait);
    }
}
