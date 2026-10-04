//! A tiny namespace-aware XML tree, enough to read WebDAV multistatus
//! responses.

use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;

pub const DAV: &str = "DAV:";
pub const CALDAV: &str = "urn:ietf:params:xml:ns:caldav";
pub const CS: &str = "http://calendarserver.org/ns/";
pub const ICAL: &str = "http://apple.com/ns/ical/";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Element {
    pub ns: String,
    pub name: String,
    pub text: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Element>,
}

impl Element {
    pub fn is(&self, ns: &str, name: &str) -> bool {
        self.ns == ns && self.name == name
    }

    pub fn child(&self, ns: &str, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.is(ns, name))
    }

    pub fn children_named<'a>(&'a self, ns: &'a str, name: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
        self.children.iter().filter(move |c| c.is(ns, name))
    }

    pub fn path(&self, path: &[(&str, &str)]) -> Option<&Element> {
        let mut cur = self;
        for (ns, name) in path {
            cur = cur.child(ns, name)?;
        }
        Some(cur)
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    pub fn trimmed(&self) -> &str {
        self.text.trim()
    }

    /// Concatenated text of all `href` children (e.g. for calendar-home-set).
    pub fn hrefs(&self) -> Vec<String> {
        self.children_named(DAV, "href").map(|h| h.trimmed().to_string()).filter(|h| !h.is_empty()).collect()
    }
}

pub fn parse(xml: &str) -> Result<Element, String> {
    let mut reader = NsReader::from_str(xml);
    let mut stack: Vec<Element> = vec![Element::default()];

    loop {
        let (ns, event) = reader.read_resolved_event().map_err(|e| e.to_string())?;
        let ns = match ns {
            ResolveResult::Bound(n) => n.as_ref().to_string(),
            _ => String::new(),
        };
        match event {
            Event::Start(e) => {
                let attrs = read_attrs(&e);
                stack.push(Element { ns, name: e.local_name().as_ref().to_string(), attrs, ..Default::default() });
            }
            Event::Empty(e) => {
                let attrs = read_attrs(&e);
                let el = Element { ns, name: e.local_name().as_ref().to_string(), attrs, ..Default::default() };
                stack.last_mut().expect("root").children.push(el);
            }
            Event::End(_) => {
                if stack.len() < 2 {
                    return Err("unbalanced XML".into());
                }
                let el = stack.pop().expect("checked");
                stack.last_mut().expect("root").children.push(el);
            }
            Event::Text(t) => stack.last_mut().expect("root").text.push_str(&t.xml10_content()),
            Event::CData(c) => stack.last_mut().expect("root").text.push_str(&c.into_inner()),
            Event::GeneralRef(r) => {
                let top = stack.last_mut().expect("root");
                if let Ok(Some(ch)) = r.resolve_char_ref() {
                    top.text.push(ch);
                } else {
                    let name = r.into_inner();
                    match quick_xml::escape::resolve_predefined_entity(&name) {
                        Some(s) => top.text.push_str(s),
                        None => {
                            top.text.push('&');
                            top.text.push_str(&name);
                            top.text.push(';');
                        }
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err("unexpected end of XML document".into());
    }
    stack.pop().expect("root").children.into_iter().next().ok_or_else(|| "empty XML document".into())
}

fn read_attrs(e: &quick_xml::events::BytesStart<'_>) -> Vec<(String, String)> {
    e.attributes()
        .flatten()
        .filter_map(|a| {
            let key = a.key.local_name().as_ref().to_string();
            let value = a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok()?.into_owned();
            Some((key, value))
        })
        .collect()
}

pub fn escape(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}

/// One `<d:response>` of a multistatus body.
#[derive(Debug, Clone)]
pub struct DavResponse {
    pub href: String,
    /// Status of the whole response (used for deleted members in reports).
    pub status: Option<u16>,
    /// Properties found with a 2xx propstat status.
    pub props: Vec<Element>,
}

impl DavResponse {
    pub fn prop(&self, ns: &str, name: &str) -> Option<&Element> {
        self.props.iter().find(|p| p.is(ns, name))
    }

    pub fn prop_text(&self, ns: &str, name: &str) -> Option<String> {
        self.prop(ns, name).map(|p| p.trimmed().to_string()).filter(|s| !s.is_empty())
    }
}

fn status_code(s: &str) -> Option<u16> {
    // "HTTP/1.1 200 OK"
    s.split_whitespace().nth(1).and_then(|c| c.parse().ok())
}

pub fn parse_multistatus(xml: &str) -> Result<Vec<DavResponse>, String> {
    let root = parse(xml)?;
    if !root.is(DAV, "multistatus") {
        return Err(format!("expected multistatus, got <{}>", root.name));
    }
    let mut out = Vec::new();
    for resp in root.children_named(DAV, "response") {
        let Some(href) = resp.child(DAV, "href").map(|h| h.trimmed().to_string()) else { continue };
        let status = resp.child(DAV, "status").and_then(|s| status_code(s.trimmed()));
        let mut props = Vec::new();
        for ps in resp.children_named(DAV, "propstat") {
            let ok = ps.child(DAV, "status").and_then(|s| status_code(s.trimmed())).is_some_and(|c| (200..300).contains(&c));
            if ok {
                if let Some(p) = ps.child(DAV, "prop") {
                    props.extend(p.children.iter().cloned());
                }
            }
        }
        out.push(DavResponse { href, status, props });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sabre_multistatus() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
 <d:response>
  <d:href>/dav.php/calendars/user/default/a.ics</d:href>
  <d:propstat>
   <d:prop>
    <d:getetag>&quot;abc&quot;</d:getetag>
    <cal:calendar-data>BEGIN:VCALENDAR&#13;
SUMMARY:Fish &amp; chips&#13;
END:VCALENDAR&#13;
</cal:calendar-data>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat>
   <d:prop><cs:getctag/></d:prop>
   <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/dav.php/calendars/user/default/b.ics</d:href>
  <d:status>HTTP/1.1 404 Not Found</d:status>
 </d:response>
</d:multistatus>"#;
        let r = parse_multistatus(xml).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].prop_text(DAV, "getetag").unwrap(), "\"abc\"");
        let data = r[0].prop(CALDAV, "calendar-data").unwrap().text.clone();
        assert!(data.contains("SUMMARY:Fish & chips\r\n"));
        assert!(r[0].prop(CS, "getctag").is_none());
        assert_eq!(r[1].status, Some(404));
    }

    #[test]
    fn default_namespace_and_cdata() {
        let xml = r#"<multistatus xmlns="DAV:"><response><href>/x</href><propstat><prop><displayname><![CDATA[A <b>]]></displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#;
        let r = parse_multistatus(xml).unwrap();
        assert_eq!(r[0].prop_text(DAV, "displayname").unwrap(), "A <b>");
    }
}
