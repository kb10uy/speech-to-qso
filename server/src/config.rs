//! Server configuration.

use url::Url;

/// Parses the URL the app is served at. Passkeys are bound to its host, so it must not change
/// once users have registered passkeys.
pub fn parse_public_origin(s: &str) -> Result<Url, String> {
    let url = Url::parse(s.trim()).map_err(|e| format!("PUBLIC_ORIGIN {s:?}: {e}"))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => {
            return Err(format!(
                "PUBLIC_ORIGIN {s:?}: passkeys need https (or http://localhost)"
            ));
        }
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(format!(
            "PUBLIC_ORIGIN {s:?}: must be an origin such as https://qso.example.com (the app is served at the root)"
        ));
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(format!("PUBLIC_ORIGIN {s:?}: must be an origin"));
    }
    Ok(url)
}

/// The value browsers send in the `Origin` header for this URL.
pub fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_origins() {
        let url = parse_public_origin("https://qso.example.com/").unwrap();
        assert_eq!(origin_of(&url), "https://qso.example.com");
        let url = parse_public_origin("http://localhost:8080").unwrap();
        assert_eq!(origin_of(&url), "http://localhost:8080");
    }

    #[test]
    fn rejects_everything_else() {
        for bad in [
            "qso.example.com",
            "http://qso.example.com",
            "https://example.com/speech-to-qso",
            "https://example.com/?a=b",
            "https://user@example.com",
            "ftp://example.com",
        ] {
            assert!(parse_public_origin(bad).is_err(), "{bad}");
        }
    }
}
