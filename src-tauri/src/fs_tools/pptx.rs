//! PowerPoint (.pptx) generation. Wire shape: a `Vec<PptxSlide>` where
//! each slide has a title, an optional image, optional bullets, and a
//! layout flag. `build_pptx` hand-rolls OOXML packaging via the `zip`
//! crate; the slide types are also reused by ODP (`super::odp`) since
//! both formats accept the same input shape.

use super::images::{build_image_index, load_image_set, ImageIndex, LoadedImage};
use super::markdown_inline::escape_xml;
use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path_for_write, write_bytes_to_workdir,
};
use std::collections::{BTreeSet, HashMap};
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

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
pub struct PptxBullet {
    pub text: String,
    pub level: u32,
}

impl<'de> serde::Deserialize<'de> for PptxBullet {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Plain(String),
            Structured { text: String, level: Option<u32> },
        }
        match Raw::deserialize(deserializer)? {
            Raw::Plain(text) => Ok(PptxBullet { text, level: 0 }),
            Raw::Structured { text, level } => Ok(PptxBullet {
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
pub enum PptxLayout {
    #[default]
    Content,
    Section,
}

/// Data shape for a single slide in a PPTX / ODP presentation. Shared by
/// both `build_pptx` and `build_odp`. Layout, subtitle, nested bullets,
/// and image were added as optional fields so old callers (and the
/// model's existing mental model of the tool) keep working — a slide
/// that only sets title and a flat list of string bullets behaves
/// exactly as before the extension.
#[derive(serde::Deserialize)]
pub struct PptxSlide {
    pub title: String,
    #[serde(default)]
    pub bullets: Vec<PptxBullet>,
    /// Only used when `layout = Section`. Rendered below the main title
    /// in a smaller font for an optional tagline.
    #[serde(default)]
    pub subtitle: Option<String>,
    /// Relative path (inside the working directory) to an image file to
    /// embed on this slide. Supported extensions: png, jpg, jpeg, gif.
    /// When set, the content area is split — bullets occupy the left
    /// half and the image occupies the right half.
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub layout: PptxLayout,
}

/// Local alias for the `ZipWriter` shape used everywhere in this module
/// (writing through a `Cursor<&mut Vec<u8>>` accumulator). Avoids
/// spelling the full generic in every helper signature.
type Zip<'a> = ZipWriter<Cursor<&'a mut Vec<u8>>>;

fn write_part(
    zip: &mut Zip<'_>,
    name: &str,
    opts: SimpleFileOptions,
    body: &[u8],
) -> Result<(), String> {
    zip.start_file(name, opts).map_err(|e| e.to_string())?;
    zip.write_all(body).map_err(|e| e.to_string())
}

/// `[Content_Types].xml` — declares the MIME type of every part in
/// the package. One Override per slide plus one Default per unique
/// image extension actually used. (Declaring image extensions we
/// don't use is fine for PowerPoint but LibreOffice warns.)
fn write_content_types(
    zip: &mut Zip<'_>,
    opts: SimpleFileOptions,
    exts: &BTreeSet<&str>,
    slide_count: usize,
) -> Result<(), String> {
    let mut content_types = super::ooxml::content_types_prologue(exts);
    content_types.push_str(
        r#"<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
"#,
    );
    for i in 1..=slide_count {
        content_types.push_str(&format!(
            r#"<Override PartName="/ppt/slides/slide{}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
"#,
            i
        ));
    }
    content_types.push_str("</Types>");
    write_part(zip, "[Content_Types].xml", opts, content_types.as_bytes())
}

/// `_rels/.rels` — root relationships point to the presentation.
fn write_root_rels(zip: &mut Zip<'_>, opts: SimpleFileOptions) -> Result<(), String> {
    write_part(
        zip,
        "_rels/.rels",
        opts,
        super::ooxml::root_rels("ppt/presentation.xml").as_bytes(),
    )
}

/// `ppt/presentation.xml` — slide master ref + per-slide IDs + 16:9
/// slide dimensions.
fn write_presentation_xml(
    zip: &mut Zip<'_>,
    opts: SimpleFileOptions,
    slide_count: usize,
) -> Result<(), String> {
    let mut presentation = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>"#,
    );
    // Slide IDs must be >= 256 per OOXML spec. rId2.. because rId1
    // is used for the slide master.
    for i in 0..slide_count {
        presentation.push_str(&format!(
            r#"<p:sldId id="{}" r:id="rId{}"/>"#,
            256 + i,
            2 + i
        ));
    }
    presentation.push_str(
        r#"</p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>"#,
    );
    write_part(zip, "ppt/presentation.xml", opts, presentation.as_bytes())
}

/// `ppt/_rels/presentation.xml.rels` — master is rId1, slides are
/// rId2..rId(N+1).
fn write_presentation_rels(
    zip: &mut Zip<'_>,
    opts: SimpleFileOptions,
    slide_count: usize,
) -> Result<(), String> {
    let mut pres_rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
"#,
    );
    for i in 1..=slide_count {
        pres_rels.push_str(&format!(
            r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{}.xml"/>
"#,
            1 + i,
            i
        ));
    }
    pres_rels.push_str("</Relationships>");
    write_part(
        zip,
        "ppt/_rels/presentation.xml.rels",
        opts,
        pres_rels.as_bytes(),
    )
}

/// `ppt/slideMasters/slideMaster1.xml` — minimal master with an empty
/// shape tree and a color map. Required by OOXML; nothing visible on
/// it because each slide carries its own title and body.
fn write_slide_master(zip: &mut Zip<'_>, opts: SimpleFileOptions) -> Result<(), String> {
    write_part(
        zip,
        "ppt/slideMasters/slideMaster1.xml",
        opts,
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>"#,
    )
}

fn write_slide_master_rels(zip: &mut Zip<'_>, opts: SimpleFileOptions) -> Result<(), String> {
    write_part(
        zip,
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        opts,
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"#,
    )
}

/// `ppt/slideLayouts/slideLayout1.xml` — single blank layout shared
/// by every slide in the deck.
fn write_slide_layout(zip: &mut Zip<'_>, opts: SimpleFileOptions) -> Result<(), String> {
    write_part(
        zip,
        "ppt/slideLayouts/slideLayout1.xml",
        opts,
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>"#,
    )
}

fn write_slide_layout_rels(zip: &mut Zip<'_>, opts: SimpleFileOptions) -> Result<(), String> {
    write_part(
        zip,
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        opts,
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"#,
    )
}

/// `ppt/theme/theme1.xml` — minimal but spec-compliant theme. OOXML
/// requires exactly 3 fill, line, effect, and bg-fill style entries.
fn write_theme(zip: &mut Zip<'_>, opts: SimpleFileOptions) -> Result<(), String> {
    write_part(
        zip,
        "ppt/theme/theme1.xml",
        opts,
        br##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
<a:themeElements>
<a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Office">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Office">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>"##,
    )
}

/// `ppt/media/image{N}.{ext}` — embed every referenced image as a
/// binary part. Order matches `ImageIndex::ordered` so filenames
/// stay deterministic.
fn write_media(
    zip: &mut Zip<'_>,
    opts: SimpleFileOptions,
    index: &ImageIndex<'_>,
    images: &HashMap<String, LoadedImage>,
) -> Result<(), String> {
    for (i, path) in index.ordered.iter().enumerate() {
        let img = images
            .get(*path)
            .ok_or_else(|| format!("Image not loaded: {}", path))?;
        zip.start_file(format!("ppt/media/image{}.{}", i + 1, img.extension), opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// EMU constants used by the slide layout writers below.
const SLIDE_CX: i64 = 12192000; // 13.33"
const FULL_BULLET_CX: i64 = 11277600; // full content width
const HALF_BULLET_CX: i64 = 5486400; // ~6" — left half when image present
const BULLET_Y: i64 = 1828800; // 2" from top
const BULLET_CY: i64 = 4572000; // ~5"
const IMAGE_X: i64 = 6400800; // start of right half
const IMAGE_Y: i64 = 1828800;
const IMAGE_CX: i64 = 5334000; // ~5.83"
const IMAGE_CY: i64 = 4000500; // ~4.38"

/// Render a `Section` layout slide: large centered title + optional
/// subtitle, no content body.
fn render_section_slide(slide: &PptxSlide) -> String {
    let title_escaped = escape_xml(slide.title.trim());
    let title_cx: i64 = 10287000; // ~11.25"
    let title_x: i64 = (SLIDE_CX - title_cx) / 2;
    let mut out = format!(
        r#"<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="SectionTitle"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>
<a:xfrm><a:off x="{}" y="2286000"/><a:ext cx="{}" cy="1524000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
<p:txBody>
<a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/>
<a:lstStyle/>
<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="4400" b="1"/><a:t>{}</a:t></a:r></a:p>
</p:txBody>
</p:sp>
"#,
        title_x, title_cx, title_escaped
    );
    if let Some(subtitle) = slide
        .subtitle
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        out.push_str(&format!(
            r#"<p:sp>
<p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>
<a:xfrm><a:off x="{}" y="3962400"/><a:ext cx="{}" cy="762000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
<p:txBody>
<a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/>
<a:lstStyle/>
<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="2400"/><a:t>{}</a:t></a:r></a:p>
</p:txBody>
</p:sp>
"#,
            title_x,
            title_cx,
            escape_xml(subtitle)
        ));
    }
    out
}

/// Render a `Content` layout slide: title at top + bullets, with an
/// optional image on the right half.
fn render_content_slide(slide: &PptxSlide) -> String {
    let title_escaped = escape_xml(slide.title.trim());
    let mut out = format!(
        r#"<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>
<a:xfrm><a:off x="457200" y="457200"/><a:ext cx="11277600" cy="1143000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
<p:txBody>
<a:bodyPr wrap="square" rtlCol="0" anchor="t"/>
<a:lstStyle/>
<a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>{}</a:t></a:r></a:p>
</p:txBody>
</p:sp>
"#,
        title_escaped
    );
    let has_image = slide.image.is_some();
    let bullet_cx = if has_image {
        HALF_BULLET_CX
    } else {
        FULL_BULLET_CX
    };
    out.push_str(&format!(
        r#"<p:sp>
<p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>
<a:xfrm><a:off x="457200" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
<p:txBody>
<a:bodyPr wrap="square" rtlCol="0" anchor="t"/>
<a:lstStyle/>
"#,
        BULLET_Y, bullet_cx, BULLET_CY
    ));
    if slide.bullets.is_empty() {
        // An empty text body still needs at least one paragraph or
        // PowerPoint complains about the shape.
        out.push_str("<a:p/>");
    } else {
        for bullet in &slide.bullets {
            let level = bullet.level.min(2);
            // Level 0 = 18pt, Level 1 = 16pt, Level 2 = 14pt.
            let (mar_l, sz) = match level {
                0 => (457200, 1800),
                1 => (914400, 1600),
                _ => (1371600, 1400),
            };
            out.push_str(&format!(
                r#"<a:p><a:pPr marL="{}" indent="-457200" lvl="{}"><a:buChar char="-"/></a:pPr><a:r><a:rPr lang="en-US" sz="{}"/><a:t>{}</a:t></a:r></a:p>"#,
                mar_l,
                level,
                sz,
                escape_xml(bullet.text.trim())
            ));
        }
    }
    out.push_str("</p:txBody></p:sp>\n");

    if slide.image.is_some() {
        out.push_str(&format!(
            r#"<p:pic>
<p:nvPicPr><p:cNvPr id="4" name="Image"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr>
<a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
</p:pic>
"#,
            IMAGE_X, IMAGE_Y, IMAGE_CX, IMAGE_CY
        ));
    }
    out
}

/// `ppt/slides/slide{N}.xml` — one per slide. Layout branches to the
/// appropriate renderer; the XML envelope (sld/cSld/spTree/grpSpPr) is
/// shared.
fn write_slide(
    zip: &mut Zip<'_>,
    opts: SimpleFileOptions,
    slide_num: usize,
    slide: &PptxSlide,
) -> Result<(), String> {
    let mut slide_xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
"#,
    );
    match slide.layout {
        PptxLayout::Section => slide_xml.push_str(&render_section_slide(slide)),
        PptxLayout::Content => slide_xml.push_str(&render_content_slide(slide)),
    }
    slide_xml.push_str("</p:spTree></p:cSld></p:sld>");
    write_part(
        zip,
        &format!("ppt/slides/slide{}.xml", slide_num),
        opts,
        slide_xml.as_bytes(),
    )
}

/// `ppt/slides/_rels/slide{N}.xml.rels` — always points to the shared
/// layout as rId1, plus the embedded image as rId2 when present.
fn write_slide_rels(
    zip: &mut Zip<'_>,
    opts: SimpleFileOptions,
    slide_num: usize,
    slide: &PptxSlide,
    index: &ImageIndex<'_>,
    images: &HashMap<String, LoadedImage>,
) -> Result<(), String> {
    let mut slide_rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
"#,
    );
    if let Some(image_path) = &slide.image {
        let idx = index
            .by_path
            .get(image_path)
            .copied()
            .ok_or_else(|| format!("Image index missing for {}", image_path))?;
        let ext = images
            .get(image_path)
            .map(|i| i.extension.as_str())
            .ok_or_else(|| format!("Image not loaded: {}", image_path))?;
        slide_rels.push_str(&format!(
            r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image{}.{}"/>
"#,
            idx, ext
        ));
    }
    slide_rels.push_str("</Relationships>");
    write_part(
        zip,
        &format!("ppt/slides/_rels/slide{}.xml.rels", slide_num),
        opts,
        slide_rels.as_bytes(),
    )
}

/// Build a minimal PowerPoint (.pptx) file from a slice of slides.
/// 16:9 widescreen, single blank layout, hand-rolled OOXML packaging.
/// The minimum-viable package is ~10 parts even for a single-slide
/// deck — see the per-part `write_*` helpers above for the layout.
pub(super) fn build_pptx(
    slides: &[PptxSlide],
    images: &HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    if slides.is_empty() {
        return Err("At least one slide is required".to_string());
    }

    let index = build_image_index(slides.iter().filter_map(|s| s.image.as_ref()), images);

    let mut buf = Vec::new();
    {
        let mut zip = ZipWriter::new(Cursor::new(&mut buf));
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        write_content_types(&mut zip, opts, &index.unique_exts, slides.len())?;
        write_root_rels(&mut zip, opts)?;
        write_presentation_xml(&mut zip, opts, slides.len())?;
        write_presentation_rels(&mut zip, opts, slides.len())?;
        write_slide_master(&mut zip, opts)?;
        write_slide_master_rels(&mut zip, opts)?;
        write_slide_layout(&mut zip, opts)?;
        write_slide_layout_rels(&mut zip, opts)?;
        write_theme(&mut zip, opts)?;
        write_media(&mut zip, opts, &index, images)?;

        for (i, slide) in slides.iter().enumerate() {
            let slide_num = i + 1;
            write_slide(&mut zip, opts, slide_num, slide)?;
            write_slide_rels(&mut zip, opts, slide_num, slide, &index, images)?;
        }

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}

#[tauri::command]
pub async fn fs_write_pptx(
    workdir: String,
    rel_path: String,
    slides: Vec<PptxSlide>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path_for_write(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if slides.is_empty() {
        return Err("At least one slide is required".to_string());
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    // Pre-load every referenced image while we still have the workdir
    // and the async runtime. The build function itself does no I/O.
    let images = load_image_set(&workdir, slides.iter().filter_map(|s| s.image.clone()))?;

    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        build_pptx(&slides, &images)
    })
    .await
    .map_err(|e| format!("pptx build task failed: {}", e))??;

    write_bytes_to_workdir(&resolved, &bytes).await
}

#[cfg(test)]
mod tests {
    // Package parts, nested levels 0–2, section title + subtitle, one image,
    // shared images and basic escaping are covered in `fs_tools/mod.rs`.
    // These cover what those leave out.
    use super::*;
    use std::io::Read;

    fn slide(title: &str, bullets: &[(&str, u32)]) -> PptxSlide {
        PptxSlide {
            title: title.to_string(),
            bullets: bullets
                .iter()
                .map(|(t, l)| PptxBullet {
                    text: t.to_string(),
                    level: *l,
                })
                .collect(),
            subtitle: None,
            image: None,
            layout: PptxLayout::Content,
        }
    }

    fn section(title: &str, subtitle: Option<&str>) -> PptxSlide {
        PptxSlide {
            subtitle: subtitle.map(str::to_string),
            layout: PptxLayout::Section,
            ..slide(title, &[])
        }
    }

    fn entry(bytes: &[u8], name: &str) -> String {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut s = String::new();
        zip.by_name(name)
            .unwrap_or_else(|_| panic!("missing {name}"))
            .read_to_string(&mut s)
            .unwrap();
        s
    }

    fn names(bytes: &[u8]) -> Vec<String> {
        let zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        zip.file_names()
            .map(|n| n.expect("utf-8 entry name").into_owned())
            .collect()
    }

    /// The `<a:t>` run texts of a slide, in order.
    fn runs(xml: &str) -> Vec<&str> {
        xml.split("<a:t>")
            .skip(1)
            .map(|s| s.split("</a:t>").next().unwrap())
            .collect()
    }

    /// The `lvl` of each bullet paragraph, in order.
    fn levels(xml: &str) -> Vec<&str> {
        xml.split(r#"lvl=""#)
            .skip(1)
            .map(|s| s.split('"').next().unwrap())
            .collect()
    }

    fn png(bytes: &[u8]) -> LoadedImage {
        LoadedImage {
            bytes: bytes.to_vec(),
            extension: "png".into(),
        }
    }

    #[test]
    fn slides_keep_their_order_and_number_their_ids_and_rels() {
        let slides = vec![
            slide("One", &[("a", 0)]),
            section("Two", None),
            slide("Three", &[("c", 0)]),
        ];
        let bytes = build_pptx(&slides, &HashMap::new()).unwrap();
        for (i, title) in ["One", "Two", "Three"].iter().enumerate() {
            let xml = entry(&bytes, &format!("ppt/slides/slide{}.xml", i + 1));
            assert_eq!(runs(&xml)[0], *title);
        }
        assert!(!names(&bytes).iter().any(|n| n.contains("slide4")));

        let pres = entry(&bytes, "ppt/presentation.xml");
        for (id, rid) in [(256, 2), (257, 3), (258, 4)] {
            assert!(pres.contains(&format!(r#"<p:sldId id="{id}" r:id="rId{rid}"/>"#)));
        }
        let rels = entry(&bytes, "ppt/_rels/presentation.xml.rels");
        for (rid, n) in [(2, 1), (3, 2), (4, 3)] {
            assert!(rels.contains(&format!(r#"Id="rId{rid}""#)));
            assert!(rels.contains(&format!(r#"Target="slides/slide{n}.xml""#)));
        }
        let ct = entry(&bytes, "[Content_Types].xml");
        assert_eq!(ct.matches("presentationml.slide+xml").count(), 3);
        // No images: no media parts.
        assert!(!names(&bytes).iter().any(|n| n.starts_with("ppt/media/")));
    }

    #[test]
    fn bullets_keep_order_are_trimmed_and_levels_past_two_clamp() {
        let s = slide(
            "  Padded title  ",
            &[("first", 0), ("  child  ", 1), ("deep", 7), ("back", 0)],
        );
        let bytes = build_pptx(&[s], &HashMap::new()).unwrap();
        let xml = entry(&bytes, "ppt/slides/slide1.xml");
        assert_eq!(
            runs(&xml),
            vec!["Padded title", "first", "child", "deep", "back"]
        );
        assert_eq!(levels(&xml), vec!["0", "1", "2", "0"]);
        // A clamped bullet also takes level 2's size and margin.
        let deep = xml.split("<a:p>").find(|p| p.contains(">deep<")).unwrap();
        assert!(deep.contains(r#"marL="1371600""#) && deep.contains(r#"sz="1400""#));
    }

    #[test]
    fn a_content_slide_without_bullets_still_has_a_paragraph() {
        let bytes = build_pptx(&[slide("Empty", &[])], &HashMap::new()).unwrap();
        let xml = entry(&bytes, "ppt/slides/slide1.xml");
        assert!(xml.contains(r#"name="Content""#));
        assert!(xml.contains("<a:p/></p:txBody>"));
        assert_eq!(runs(&xml), vec!["Empty"]);
    }

    #[test]
    fn a_content_slide_ignores_a_subtitle_and_a_section_slide_ignores_bullets() {
        let mut content = slide("Body", &[("point", 0)]);
        content.subtitle = Some("unused tagline".into());
        let mut sec = section("Divider", None);
        sec.bullets = vec![PptxBullet {
            text: "dropped".into(),
            level: 0,
        }];
        let bytes = build_pptx(&[content, sec], &HashMap::new()).unwrap();
        let c = entry(&bytes, "ppt/slides/slide1.xml");
        assert_eq!(runs(&c), vec!["Body", "point"]);
        let s = entry(&bytes, "ppt/slides/slide2.xml");
        assert_eq!(runs(&s), vec!["Divider"]);
        assert!(!s.contains("lvl="));
    }

    #[test]
    fn a_blank_subtitle_adds_no_subtitle_shape() {
        for sub in [None, Some(""), Some("   ")] {
            let bytes = build_pptx(&[section("Part", sub)], &HashMap::new()).unwrap();
            let xml = entry(&bytes, "ppt/slides/slide1.xml");
            assert!(!xml.contains(r#"name="Subtitle""#), "{sub:?}");
            assert_eq!(runs(&xml), vec!["Part"]);
        }
        let bytes = build_pptx(&[section("Part", Some("  Tag  "))], &HashMap::new()).unwrap();
        let xml = entry(&bytes, "ppt/slides/slide1.xml");
        assert_eq!(runs(&xml), vec!["Part", "Tag"]);
    }

    #[test]
    fn section_title_and_subtitle_are_escaped() {
        let bytes = build_pptx(
            &[section("R&D <2026>", Some("Q&A > \"all\""))],
            &HashMap::new(),
        )
        .unwrap();
        let xml = entry(&bytes, "ppt/slides/slide1.xml");
        assert_eq!(
            runs(&xml),
            vec!["R&amp;D &lt;2026&gt;", "Q&amp;A &gt; &quot;all&quot;"]
        );
        assert!(!xml.contains("R&D"));
    }

    #[test]
    fn an_image_halves_the_bullet_column_and_each_slide_points_at_its_own() {
        let mut images = HashMap::new();
        images.insert("a.png".to_string(), png(b"AAA"));
        images.insert(
            "b.jpg".to_string(),
            LoadedImage {
                bytes: b"BBB".to_vec(),
                extension: "jpg".into(),
            },
        );
        let mut s1 = slide("With b", &[("x", 0)]);
        s1.image = Some("b.jpg".into());
        let s2 = slide("No image", &[("y", 0)]);
        let mut s3 = slide("With a", &[("z", 0)]);
        s3.image = Some("a.png".into());
        let bytes = build_pptx(&[s1, s2, s3], &images).unwrap();

        // Media is numbered by first appearance, not by name.
        let mut zip = zip::ZipArchive::new(Cursor::new(&bytes[..])).unwrap();
        let mut read = |n: &str| {
            let mut v = Vec::new();
            zip.by_name(n).unwrap().read_to_end(&mut v).unwrap();
            v
        };
        assert_eq!(read("ppt/media/image1.jpg"), b"BBB");
        assert_eq!(read("ppt/media/image2.png"), b"AAA");

        let rels1 = entry(&bytes, "ppt/slides/_rels/slide1.xml.rels");
        assert!(rels1.contains("../media/image1.jpg"));
        let rels2 = entry(&bytes, "ppt/slides/_rels/slide2.xml.rels");
        assert!(!rels2.contains("rId2"));
        let rels3 = entry(&bytes, "ppt/slides/_rels/slide3.xml.rels");
        assert!(rels3.contains("../media/image2.png"));

        let half = format!(r#"cx="{HALF_BULLET_CX}""#);
        let full = format!(r#"cx="{FULL_BULLET_CX}" cy="{BULLET_CY}""#);
        let x1 = entry(&bytes, "ppt/slides/slide1.xml");
        assert!(x1.contains(&half) && x1.contains("<p:pic>"));
        let x2 = entry(&bytes, "ppt/slides/slide2.xml");
        assert!(x2.contains(&full) && !x2.contains("<p:pic>"));

        let ct = entry(&bytes, "[Content_Types].xml");
        assert!(ct.contains(r#"Extension="png""#));
        assert!(ct.contains(r#"Extension="jpg""#));
    }

    #[test]
    fn an_image_that_was_not_loaded_is_an_error() {
        let mut s = slide("Missing", &[]);
        s.image = Some("gone.png".into());
        let err = build_pptx(&[s], &HashMap::new()).unwrap_err();
        assert!(err.contains("gone.png"), "{err}");
    }

    #[test]
    fn every_xml_part_is_well_formed_enough_to_close_its_root() {
        let bytes = build_pptx(
            &[slide("A", &[("b", 0)]), section("C", Some("d"))],
            &HashMap::new(),
        )
        .unwrap();
        for name in names(&bytes) {
            if !(name.ends_with(".xml") || name.ends_with(".rels")) {
                continue;
            }
            let xml = entry(&bytes, &name);
            assert!(xml.starts_with("<?xml"), "{name}");
            // The root element's name, then its closing tag at the very end.
            let root = xml
                .split("?>")
                .nth(1)
                .unwrap()
                .trim_start()
                .trim_start_matches('<')
                .split([' ', '>'])
                .next()
                .unwrap()
                .to_string();
            assert!(
                xml.trim_end().ends_with(&format!("</{root}>")),
                "{name}: root {root} not closed"
            );
        }
    }
}
