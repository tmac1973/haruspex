//! XML escaping for the deck (ODP) and spreadsheet (XLSX) writers.

pub(super) use crate::text_util::escape_xml;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_the_five_xml_specials() {
        assert_eq!(
            escape_xml(r#"<a href="x">Tom & Jerry's</a>"#),
            "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;"
        );
    }
}
