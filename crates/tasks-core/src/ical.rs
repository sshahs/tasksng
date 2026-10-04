//! A small, loss-less iCalendar (RFC 5545) reader/writer.
//!
//! Task objects on a CalDAV server are frequently written by other clients
//! (Thunderbird, Apple Reminders, Tasks.org, DAVx⁵ …) which add properties we
//! know nothing about. To never destroy that data we keep every component and
//! property we parse and only touch the ones we explicitly edit.

use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Param {
    pub name: String,
    /// Unquoted parameter values.
    pub values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Property {
    pub name: String,
    pub params: Vec<Param>,
    /// Raw value exactly as found in the content line (still escaped).
    pub value: String,
}

impl Property {
    pub fn new(name: &str, value: impl Into<String>) -> Self {
        Property { name: name.to_string(), params: Vec::new(), value: value.into() }
    }

    pub fn with_param(mut self, name: &str, value: &str) -> Self {
        self.set_param(name, value);
        self
    }

    pub fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case(name))
            .and_then(|p| p.values.first())
            .map(String::as_str)
    }

    pub fn set_param(&mut self, name: &str, value: &str) {
        if let Some(p) = self.params.iter_mut().find(|p| p.name.eq_ignore_ascii_case(name)) {
            p.values = vec![value.to_string()];
        } else {
            self.params.push(Param { name: name.to_string(), values: vec![value.to_string()] });
        }
    }

    pub fn remove_param(&mut self, name: &str) {
        self.params.retain(|p| !p.name.eq_ignore_ascii_case(name));
    }

    /// The value with TEXT escaping removed.
    pub fn text(&self) -> String {
        unescape_text(&self.value)
    }

    fn write_line(&self, out: &mut String) {
        let mut line = String::with_capacity(self.name.len() + self.value.len() + 8);
        line.push_str(&self.name);
        for p in &self.params {
            line.push(';');
            line.push_str(&p.name);
            line.push('=');
            for (i, v) in p.values.iter().enumerate() {
                if i > 0 {
                    line.push(',');
                }
                if v.contains([':', ';', ',']) {
                    line.push('"');
                    line.push_str(&v.replace('"', "'"));
                    line.push('"');
                } else {
                    line.push_str(v);
                }
            }
        }
        line.push(':');
        line.push_str(&self.value);
        fold_into(&line, out);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Component {
    pub name: String,
    pub props: Vec<Property>,
    pub children: Vec<Component>,
}

impl Component {
    pub fn new(name: &str) -> Self {
        Component { name: name.to_string(), props: Vec::new(), children: Vec::new() }
    }

    pub fn get(&self, name: &str) -> Option<&Property> {
        self.props.iter().find(|p| p.name.eq_ignore_ascii_case(name))
    }

    pub fn get_mut(&mut self, name: &str) -> Option<&mut Property> {
        self.props.iter_mut().find(|p| p.name.eq_ignore_ascii_case(name))
    }

    pub fn get_all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Property> + 'a {
        self.props.iter().filter(move |p| p.name.eq_ignore_ascii_case(name))
    }

    pub fn text(&self, name: &str) -> Option<String> {
        self.get(name).map(Property::text)
    }

    /// Replaces the first property called `prop.name` (dropping duplicates)
    /// or appends it when missing. The position of an existing property is
    /// kept so diffs stay small.
    pub fn set(&mut self, prop: Property) {
        match self.props.iter().position(|p| p.name.eq_ignore_ascii_case(&prop.name)) {
            Some(idx) => {
                let name = prop.name.clone();
                self.props[idx] = prop;
                let mut seen = false;
                self.props.retain(|p| {
                    if p.name.eq_ignore_ascii_case(&name) {
                        let keep = !seen;
                        seen = true;
                        keep
                    } else {
                        true
                    }
                });
            }
            None => self.props.push(prop),
        }
    }

    pub fn set_text(&mut self, name: &str, value: &str) {
        let mut prop = self.get(name).cloned().unwrap_or_else(|| Property::new(name, ""));
        prop.value = escape_text(value);
        // Language/alternate representation no longer match the new text.
        prop.remove_param("ALTREP");
        self.set(prop);
    }

    pub fn remove(&mut self, name: &str) {
        self.props.retain(|p| !p.name.eq_ignore_ascii_case(name));
    }

    pub fn push(&mut self, prop: Property) {
        self.props.push(prop);
    }

    pub fn child(&self, name: &str) -> Option<&Component> {
        self.children.iter().find(|c| c.name.eq_ignore_ascii_case(name))
    }

    pub fn to_ics(&self) -> String {
        let mut out = String::with_capacity(512);
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        let _ = write!(out, "BEGIN:{}\r\n", self.name);
        for p in &self.props {
            p.write_line(out);
        }
        for c in &self.children {
            c.write(out);
        }
        let _ = write!(out, "END:{}\r\n", self.name);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid iCalendar data: {0}")]
pub struct ParseError(pub String);

/// Parses an iCalendar stream and returns its root component (normally
/// `VCALENDAR`).
pub fn parse(input: &str) -> Result<Component, ParseError> {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut stack: Vec<Component> = Vec::new();
    let mut root: Option<Component> = None;

    for line in unfold(input) {
        if line.trim().is_empty() {
            continue;
        }
        let prop = parse_line(&line)?;
        if prop.name.eq_ignore_ascii_case("BEGIN") {
            stack.push(Component::new(&prop.value.trim().to_ascii_uppercase()));
        } else if prop.name.eq_ignore_ascii_case("END") {
            let comp = stack.pop().ok_or_else(|| ParseError("unexpected END".into()))?;
            if !comp.name.eq_ignore_ascii_case(prop.value.trim()) {
                return Err(ParseError(format!("END:{} does not close {}", prop.value, comp.name)));
            }
            match stack.last_mut() {
                Some(parent) => parent.children.push(comp),
                None => {
                    if root.is_none() {
                        root = Some(comp);
                    }
                }
            }
        } else {
            match stack.last_mut() {
                Some(c) => c.props.push(prop),
                None => return Err(ParseError("property outside of a component".into())),
            }
        }
    }
    if let Some(open) = stack.last() {
        return Err(ParseError(format!("component {} is never closed", open.name)));
    }
    root.ok_or_else(|| ParseError("no component found".into()))
}

fn unfold(input: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in input.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = raw.strip_prefix([' ', '\t']) {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        lines.push(raw.to_string());
    }
    lines
}

fn parse_line(line: &str) -> Result<Property, ParseError> {
    let bytes = line.as_bytes();
    let name_end = line
        .find([';', ':'])
        .ok_or_else(|| ParseError(format!("missing ':' in line '{}'", truncate(line))))?;
    let name = line[..name_end].trim().to_string();
    if name.is_empty() {
        return Err(ParseError(format!("empty property name in '{}'", truncate(line))));
    }

    let mut params = Vec::new();
    let mut i = name_end;
    while i < bytes.len() && bytes[i] == b';' {
        i += 1;
        let eq = line[i..]
            .find(['=', ':', ';'])
            .map(|p| p + i)
            .ok_or_else(|| ParseError(format!("bad parameter in '{}'", truncate(line))))?;
        let pname = line[i..eq].to_string();
        if bytes[eq] != b'=' {
            // Parameter without value (invalid but tolerated).
            params.push(Param { name: pname, values: vec![] });
            i = eq;
            continue;
        }
        i = eq + 1;
        let mut values = Vec::new();
        loop {
            if i < bytes.len() && bytes[i] == b'"' {
                let close = line[i + 1..]
                    .find('"')
                    .map(|p| p + i + 1)
                    .ok_or_else(|| ParseError(format!("unterminated quote in '{}'", truncate(line))))?;
                values.push(line[i + 1..close].to_string());
                i = close + 1;
            } else {
                let end = line[i..].find([',', ';', ':']).map(|p| p + i).unwrap_or(bytes.len());
                values.push(line[i..end].to_string());
                i = end;
            }
            if i < bytes.len() && bytes[i] == b',' {
                i += 1;
                continue;
            }
            break;
        }
        params.push(Param { name: pname, values });
    }
    if i >= bytes.len() || bytes[i] != b':' {
        return Err(ParseError(format!("missing value in '{}'", truncate(line))));
    }
    Ok(Property { name, params, value: line[i + 1..].to_string() })
}

fn truncate(s: &str) -> &str {
    match s.char_indices().nth(60) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Folds a content line to at most 75 octets per physical line.
fn fold_into(line: &str, out: &mut String) {
    let mut limit = 75;
    let mut start = 0;
    while line.len() - start > limit {
        let mut end = start + limit;
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&line[start..end]);
        out.push_str("\r\n ");
        start = end;
        limit = 74;
    }
    out.push_str(&line[start..]);
    out.push_str("\r\n");
}

pub fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

pub fn unescape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Splits a multi-valued TEXT property (e.g. CATEGORIES) on unescaped commas
/// and unescapes every item.
pub fn split_text_list(s: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut cur = String::new();
    let mut escaped = false;
    for c in s.chars() {
        if escaped {
            cur.push('\\');
            cur.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == ',' {
            items.push(unescape_text(&cur));
            cur.clear();
        } else {
            cur.push(c);
        }
    }
    if escaped {
        cur.push('\\');
    }
    items.push(unescape_text(&cur));
    items.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

pub fn join_text_list(items: &[String]) -> String {
    items.iter().map(|s| escape_text(s.trim())).collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VTODO\r\nUID:abc-123\r\nSUMMARY:Buy milk\\, eggs\\; bread\r\nDESCRIPTION:Line one\\nLine two with a very long text that definitely needs t\r\n o be folded somewhere\r\nX-UNKNOWN;X-PARAM=\"a:b;c\":keep me\r\nCATEGORIES:Home,Errands\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";

    #[test]
    fn parses_and_unfolds() {
        let cal = parse(SAMPLE).unwrap();
        assert_eq!(cal.name, "VCALENDAR");
        let todo = cal.child("VTODO").unwrap();
        assert_eq!(todo.text("SUMMARY").unwrap(), "Buy milk, eggs; bread");
        assert_eq!(
            todo.text("DESCRIPTION").unwrap(),
            "Line one\nLine two with a very long text that definitely needs to be folded somewhere"
        );
        let x = todo.get("x-unknown").unwrap();
        assert_eq!(x.param("X-PARAM"), Some("a:b;c"));
        assert_eq!(x.value, "keep me");
        assert_eq!(split_text_list(&todo.get("CATEGORIES").unwrap().value), vec!["Home", "Errands"]);
        assert_eq!(todo.children.len(), 1);
    }

    #[test]
    fn round_trips_unknown_data() {
        let cal = parse(SAMPLE).unwrap();
        let out = cal.to_ics();
        let again = parse(&out).unwrap();
        assert_eq!(cal, again);
        assert!(out.contains("X-UNKNOWN;X-PARAM=\"a:b;c\":keep me\r\n"));
        assert!(out.contains("TRIGGER:-PT15M"));
    }

    #[test]
    fn folds_long_lines_on_char_boundaries() {
        let mut c = Component::new("VTODO");
        let long = "ä".repeat(100);
        c.set_text("SUMMARY", &long);
        let out = c.to_ics();
        for l in out.split("\r\n") {
            assert!(l.len() <= 75, "line too long: {}", l.len());
        }
        let parsed = parse(&out).unwrap();
        assert_eq!(parsed.text("SUMMARY").unwrap(), long);
    }

    #[test]
    fn set_replaces_in_place_and_dedupes() {
        let mut c = Component::new("VTODO");
        c.push(Property::new("A", "1"));
        c.push(Property::new("B", "1"));
        c.push(Property::new("A", "2"));
        c.set(Property::new("A", "3"));
        assert_eq!(c.props.iter().map(|p| p.value.as_str()).collect::<Vec<_>>(), vec!["3", "1"]);
    }

    #[test]
    fn accepts_lf_only_and_bom() {
        let cal = parse("\u{feff}BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:x\nEND:VTODO\nEND:VCALENDAR\n").unwrap();
        assert_eq!(cal.child("VTODO").unwrap().text("UID").unwrap(), "x");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("BEGIN:VCALENDAR\nBEGIN:VTODO\nEND:VCALENDAR\n").is_err());
        assert!(parse("hello").is_err());
    }

    #[test]
    fn text_list_escaping() {
        let items = vec!["a,b".to_string(), "c".to_string()];
        let joined = join_text_list(&items);
        assert_eq!(joined, "a\\,b,c");
        assert_eq!(split_text_list(&joined), items);
    }
}
