//! Shared Office Open XML (OOXML) packaging fragments for the .docx and
//! .pptx writers. Only the byte-identical package-metadata pieces live here;
//! each builder appends its own part `<Override>`s and body.

use std::collections::BTreeSet;

/// Opening of an OOXML `[Content_Types].xml`: the XML declaration, the
/// `<Types>` root, the two mandatory `<Default>` entries (`rels`, `xml`), and
/// one `<Default Extension=.. ContentType="image/..">` per image extension
/// actually used. The caller appends its part `<Override>`s and the closing
/// `</Types>`.
pub(super) fn content_types_prologue(exts: &BTreeSet<&str>) -> String {
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
"#,
    );
    for ext in exts {
        s.push_str(&format!(
            r#"<Default Extension="{}" ContentType="image/{}"/>
"#,
            ext, ext
        ));
    }
    s
}

/// `_rels/.rels` — the package-level relationship pointing at the main
/// document part (`target`, e.g. `word/document.xml` or
/// `ppt/presentation.xml`).
pub(super) fn root_rels(target: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{}"/>
</Relationships>"#,
        target
    )
}
