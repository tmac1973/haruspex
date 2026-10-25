//! An index over a `.kdenlive` file that remembers where every element sits.
//!
//! Nothing here re-serialises a document. An edit replaces exact byte ranges
//! of the original text and leaves the rest alone, which is what lets a user's
//! own effects, guides and tracks, and any property Haruspex has never heard
//! of, survive a model's edit byte for byte.

use quick_xml::events::Event;
use quick_xml::Reader;
use std::ops::Range;

#[derive(Clone, Debug)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    /// The whole element, from `<` of its start tag to the end of its end tag
    /// (or of the self-closing tag).
    pub span: Range<usize>,
    /// Where its children start: just after the start tag. Equal to
    /// `span.end` for a self-closing element.
    pub inner_start: usize,
    /// Where its end tag starts. Equal to `span.end` when self-closing.
    pub inner_end: usize,
    pub children: Vec<usize>,
    /// Its own text, unescaped and joined: a `<property>`'s value.
    pub text: String,
}

impl Node {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn self_closing(&self) -> bool {
        self.inner_start == self.span.end
    }
}

#[derive(Clone, Debug)]
pub struct Tree {
    pub nodes: Vec<Node>,
    /// The document element (`<mlt>`).
    pub root: usize,
}

impl Tree {
    pub fn parse(text: &str) -> Result<Tree, String> {
        let mut reader = Reader::from_str(text);
        reader.config_mut().trim_text(false);
        let mut nodes: Vec<Node> = Vec::new();
        let mut stack: Vec<usize> = Vec::new();
        let mut root = None;
        loop {
            let before = reader.buffer_position() as usize;
            let event = reader
                .read_event()
                .map_err(|e| format!("not a readable Kdenlive project: {e}"))?;
            let after = reader.buffer_position() as usize;
            match event {
                Event::Start(e) | Event::Empty(e) => {
                    let closing = text.as_bytes()[..after].ends_with(b"/>");
                    let name = e.name().into_inner().to_string();
                    let mut attrs = Vec::new();
                    for a in e.attributes() {
                        let a = a.map_err(|err| format!("bad attribute: {err}"))?;
                        let value = a
                            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .map_err(|err| format!("bad attribute: {err}"))?
                            .into_owned();
                        attrs.push((a.key.into_inner().to_string(), value));
                    }
                    let id = nodes.len();
                    let parent = stack.last().copied();
                    nodes.push(Node {
                        name,
                        attrs,
                        span: before..after,
                        inner_start: after,
                        inner_end: after,
                        children: Vec::new(),
                        text: String::new(),
                    });
                    match parent {
                        Some(p) => nodes[p].children.push(id),
                        None => root = root.or(Some(id)),
                    }
                    if !closing {
                        stack.push(id);
                    }
                }
                Event::End(_) => {
                    let id = stack.pop().ok_or("unbalanced end tag")?;
                    nodes[id].inner_end = before;
                    nodes[id].span.end = after;
                }
                Event::Text(e) => {
                    if let Some(&id) = stack.last() {
                        nodes[id].text.push_str(&e.xml10_content());
                    }
                }
                Event::CData(e) => {
                    if let Some(&id) = stack.last() {
                        nodes[id].text.push_str(&e.into_inner());
                    }
                }
                Event::GeneralRef(e) => {
                    if let Some(&id) = stack.last() {
                        let resolved = match e.resolve_char_ref() {
                            Ok(Some(c)) => c.to_string(),
                            _ => quick_xml::escape::resolve_predefined_entity(&e.into_inner())
                                .unwrap_or_default()
                                .to_string(),
                        };
                        nodes[id].text.push_str(&resolved);
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
        if !stack.is_empty() {
            return Err("the project ends before its last element closes".into());
        }
        let root = root.ok_or("the project is empty")?;
        Ok(Tree { nodes, root })
    }

    pub fn node(&self, id: usize) -> &Node {
        &self.nodes[id]
    }

    /// Child elements of `id` named `name`, in order.
    pub fn children_named<'a>(
        &'a self,
        id: usize,
        name: &'a str,
    ) -> impl Iterator<Item = usize> + 'a {
        self.nodes[id]
            .children
            .iter()
            .copied()
            .filter(move |&c| self.nodes[c].name == name)
    }

    /// The value of `<property name="…">` directly under `id`.
    pub fn property(&self, id: usize, name: &str) -> Option<&str> {
        self.property_node(id, name)
            .map(|p| self.nodes[p].text.as_str())
    }

    pub fn property_node(&self, id: usize, name: &str) -> Option<usize> {
        self.children_named(id, "property")
            .find(|&p| self.nodes[p].attr("name") == Some(name))
    }

    /// The top-level element with `id="…"`.
    pub fn by_id(&self, id: &str) -> Option<usize> {
        self.nodes[self.root]
            .children
            .iter()
            .copied()
            .find(|&c| self.nodes[c].attr("id") == Some(id))
    }
}

/// Escape text for an attribute value or element content.
pub fn escape(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}

/// Replacements over the original text, applied together.
#[derive(Default)]
pub struct Splices {
    edits: Vec<(Range<usize>, String)>,
}

impl Splices {
    pub fn replace(&mut self, range: Range<usize>, with: String) {
        self.edits.push((range, with));
    }

    pub fn insert(&mut self, at: usize, text: String) {
        self.edits.push((at..at, text));
    }

    /// Apply them all. Overlapping ranges are a bug in the caller.
    pub fn apply(mut self, text: &str) -> Result<String, String> {
        // Stable, so two inserts at one point land in the order they were made.
        self.edits.sort_by_key(|(r, _)| (r.start, r.end));
        for pair in self.edits.windows(2) {
            if pair[1].0.start < pair[0].0.end {
                return Err("internal error: overlapping project edits".into());
            }
        }
        let mut out = String::with_capacity(text.len() + 1024);
        let mut at = 0;
        for (range, with) in self.edits {
            out.push_str(&text[at..range.start]);
            out.push_str(&with);
            at = range.end;
        }
        out.push_str(&text[at..]);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"<?xml version='1.0' encoding='utf-8'?>
<mlt root="/v">
 <producer id="p0" out="00:00:01.000">
  <property name="resource">a &amp; b.mp4</property>
  <property name="empty"/>
 </producer>
 <playlist id="pl"/>
</mlt>
"#;

    #[test]
    fn spans_cover_whole_elements() {
        let t = Tree::parse(DOC).unwrap();
        let p0 = t.by_id("p0").unwrap();
        let n = t.node(p0);
        assert!(DOC[n.span.clone()].starts_with("<producer id=\"p0\""));
        assert!(DOC[n.span.clone()].ends_with("</producer>"));
        assert_eq!(n.attr("out"), Some("00:00:01.000"));
        let pl = t.by_id("pl").unwrap();
        assert!(t.node(pl).self_closing());
        assert_eq!(&DOC[t.node(pl).span.clone()], "<playlist id=\"pl\"/>");
    }

    #[test]
    fn property_text_is_unescaped() {
        let t = Tree::parse(DOC).unwrap();
        let p0 = t.by_id("p0").unwrap();
        assert_eq!(t.property(p0, "resource"), Some("a & b.mp4"));
        assert_eq!(t.property(p0, "empty"), Some(""));
        assert_eq!(t.property(p0, "missing"), None);
    }

    #[test]
    fn splices_keep_everything_else() {
        let t = Tree::parse(DOC).unwrap();
        let pl = t.by_id("pl").unwrap();
        let mut s = Splices::default();
        s.replace(
            t.node(pl).span.clone(),
            "<playlist id=\"pl\">\n </playlist>".into(),
        );
        s.insert(t.node(pl).span.start, "<!-- x -->\n ".into());
        let out = s.apply(DOC).unwrap();
        assert!(out.contains("<!-- x -->\n <playlist id=\"pl\">\n </playlist>"));
        assert!(out.contains("a &amp; b.mp4"));
        assert_eq!(Splices::default().apply(DOC).unwrap(), DOC);
    }

    #[test]
    fn overlapping_edits_are_refused() {
        let mut s = Splices::default();
        s.replace(0..10, String::new());
        s.replace(5..12, String::new());
        assert!(s.apply(DOC).is_err());
    }
}
