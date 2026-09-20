use tiny_http::{Server, Response, Header, Method};
use serde::{Deserialize, Serialize};

/// Requests must carry this header. It is not CORS-safelisted, so a browser page
/// would have to preflight first — and its preflight never matches our CORS
/// headers. That is what keeps other websites from writing to the local API.
/// (A local process can still set it; this is a CSRF guard, not authentication.)
const API_HEADER: &str = "X-Noveltrackr";
const API_HEADER_VALUE: &str = "1";

/// Same threshold as the extension and AddNovelPanel.findDuplicates
const DUPLICATE_THRESHOLD: f64 = 0.75;

fn is_api_header(name: &str, value: &str) -> bool {
    name.eq_ignore_ascii_case(API_HEADER) && value == API_HEADER_VALUE
}

fn is_authorised(request: &tiny_http::Request) -> bool {
    request
        .headers()
        .iter()
        .any(|h| is_api_header(&h.field.to_string(), h.value.as_str()))
}

/// Every request opens its own connection. Without a busy timeout SQLite fails
/// instantly with SQLITE_BUSY when the UI (sqlx, 5s timeout) holds the write lock.
fn open_db(db_path: &str) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

// These mirror what the extension will send/receive
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NovelSummary {
    pub id: i64,
    pub canonical_title: String,
    pub aliases: Vec<String>,
    pub current_chapter_raw: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct UpdateProgressPayload {
    pub novel_id: i64,
    pub chapter_raw: String,
    pub source_url: String,
    pub domain: String,
}

#[derive(Deserialize, Debug)]
pub struct QuickAddPayload {
    pub title: String,
    pub chapter_raw: String,
}

#[derive(Deserialize, Debug)]
pub struct MappingPayload {
    pub domain: String,
    pub detected_title: String,
    pub novel_id: i64,
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes(
            "Access-Control-Allow-Origin",
            "chrome-extension://"
        ).unwrap(),
        Header::from_bytes(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS"
        ).unwrap(),
        Header::from_bytes(
            "Access-Control-Allow-Headers",
            "Content-Type"
        ).unwrap(),
        Header::from_bytes(
            "Content-Type",
            "application/json"
        ).unwrap(),
    ]
}

fn json_response(body: String, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    let data = body.into_bytes();
    let len = data.len();
    let response = Response::new(
        tiny_http::StatusCode(status),
        cors_headers(),
        std::io::Cursor::new(data),
        Some(len),
        None,
    );
    response
}

fn save_cover(db_path: &str, novel_id: i64, cover_url: &str) -> Result<(), String> {
    let conn = open_db(db_path)?;
    conn.execute(
        "UPDATE novels SET cover_url = ?1 WHERE id = ?2",
        rusqlite::params![cover_url, novel_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// The DB handle gets passed in from main
pub fn start_server(
    db_path: String,
) {
    start_server_on(db_path, "127.0.0.1:39172");
}

/// Same server on an arbitrary address (tests bind a throwaway port)
pub fn start_server_on(db_path: String, addr: &str) {
    let addr = addr.to_string();
    std::thread::spawn(move || {
        let server = Server::http(&addr).expect("Failed to start local server");
        
        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            
            // Handle CORS preflight
            if method == Method::Options {
                let _ = request.respond(json_response("{}".to_string(), 200));
                continue;
            }

            // Everything except the preflight must come from the extension
            if !is_authorised(&request) {
                let _ = request.respond(json_response(r#"{"error":"forbidden"}"#.to_string(), 403));
                continue;
            }

            let response = match (method.as_str(), url.as_str()) {
                // Health check — extension pings this first
                ("GET", "/status") => {
                    json_response(r#"{"running":true}"#.to_string(), 200)
                }

                // Get all novels for fuzzy matching in extension
                ("GET", url) if url.starts_with("/novels") => {
                    // Read from SQLite directly
                    match get_novels_for_extension(&db_path) {
                        Ok(novels) => {
                            json_response(serde_json::to_string(&novels).unwrap(), 200)
                        }
                        Err(e) => {
                            json_response(
                                format!(r#"{{"error":"{}"}}"#, e),
                                500
                            )
                        }
                    }
                }

                // Update progress from extension
                ("POST", "/progress") => {
                    let mut body = String::new();
                    request.as_reader().read_to_string(&mut body).unwrap_or(0);
                    
                    match serde_json::from_str::<UpdateProgressPayload>(&body) {
                        Ok(payload) => {
                            match update_progress_and_source(&db_path, &payload) {
                                Ok(_) => json_response(r#"{"ok":true}"#.to_string(), 200),
                                Err(e) => json_response(format!(r#"{{"error":"{}"}}"#, e), 500),
                            }
                        }
                        Err(e) => json_response(format!(r#"{{"error":"{}"}}"#, e), 400),
                    }
                }

                // Save a confirmed site mapping
                ("POST", "/mappings") => {
                    let mut body = String::new();
                    request.as_reader().read_to_string(&mut body).unwrap_or(0);
                    
                    match serde_json::from_str::<MappingPayload>(&body) {
                        Ok(payload) => {
                            match save_mapping(&db_path, &payload) {
                                Ok(_) => json_response(r#"{"ok":true}"#.to_string(), 200),
                                Err(e) => json_response(format!(r#"{{"error":"{}"}}"#, e), 500),
                            }
                        }
                        Err(e) => json_response(format!(r#"{{"error":"{}"}}"#, e), 400),
                    }
                }

                ("POST", "/quick-add") => {
                    let mut body = String::new();
                    request.as_reader().read_to_string(&mut body).unwrap_or(0);
                    
                    match serde_json::from_str::<QuickAddPayload>(&body) {
                        Ok(payload) => {
                            match quick_add_novel(&db_path, &payload) {
                                Ok(QuickAddResult::Added(id)) => {
                                    json_response(format!(r#"{{"ok":true,"id":{}}}"#, id), 200)
                                }
                                // Already in the library (fuzzy match) — let the user link instead of duplicating
                                Ok(QuickAddResult::Duplicate { id, title }) => json_response(
                                    format!(
                                        r#"{{"ok":false,"error":"duplicate","novel_id":{},"novel_title":{}}}"#,
                                        id,
                                        serde_json::to_string(&title).unwrap_or_else(|_| "\"\"".to_string())
                                    ),
                                    200,
                                ),
                                Err(e) => json_response(format!(r#"{{"error":"{}"}}"#, e), 500),
                            }
                        }
                        Err(e) => json_response(format!(r#"{{"error":"{}"}}"#, e), 400),
                    }
                }

                ("POST", "/cover") => {
                    let mut body = String::new();
                    request.as_reader().read_to_string(&mut body).unwrap_or(0);

                    #[derive(serde::Deserialize)]
                    struct CoverPayload {
                        novel_id: i64,
                        cover_url: String,
                    }

                    match serde_json::from_str::<CoverPayload>(&body) {
                        Ok(payload) => {
                            match save_cover(&db_path, payload.novel_id, &payload.cover_url) {
                                Ok(_) => json_response(r#"{"ok":true}"#.to_string(), 200),
                                Err(e) => json_response(format!(r#"{{"error":"{}"}}"#, e), 500),
                            }
                        }
                        Err(e) => json_response(format!(r#"{{"error":"{}"}}"#, e), 400),
                    }
                }

                _ => json_response(r#"{"error":"not found"}"#.to_string(), 404),
            };

            let _ = request.respond(response);
        }
    });
}

// ── Direct SQLite operations for the server thread ────────────────────────────
// These use rusqlite directly since we can't use tauri-plugin-sql from a thread

fn get_novels_for_extension(db_path: &str) -> Result<Vec<NovelSummary>, String> {
    let conn = open_db(db_path)?;

    // One pass instead of a query per novel; ORDER BY n.id keeps aliases contiguous
    let mut stmt = conn.prepare(
        "SELECT n.id, n.canonical_title, p.chapter_raw, a.alias
         FROM novels n
         LEFT JOIN progress p ON p.novel_id = n.id
         LEFT JOIN aliases a ON a.novel_id = n.id
         ORDER BY n.id"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })
    .map_err(|e| e.to_string())?;

    let mut result: Vec<NovelSummary> = Vec::new();
    for (id, title, chapter, alias) in rows.filter_map(|r| r.ok()) {
        match result.last_mut() {
            Some(last) if last.id == id => {
                if let Some(alias) = alias {
                    last.aliases.push(alias);
                }
            }
            _ => result.push(NovelSummary {
                id,
                canonical_title: title,
                aliases: alias.into_iter().collect(),
                current_chapter_raw: chapter,
            }),
        }
    }

    Ok(result)
}

fn update_progress_and_source(db_path: &str, payload: &UpdateProgressPayload) -> Result<(), String> {
    let conn = open_db(db_path)?;
    
    // Parse chapter sort number
    let chapter_sort = parse_chapter_sort(&payload.chapter_raw);

    // Upsert progress
    conn.execute(
        "INSERT INTO progress (novel_id, chapter_raw, chapter_sort, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(novel_id) DO UPDATE SET
           chapter_raw=excluded.chapter_raw,
           chapter_sort=excluded.chapter_sort,
           updated_at=excluded.updated_at",
        rusqlite::params![payload.novel_id, payload.chapter_raw, chapter_sort],
    ).map_err(|e| e.to_string())?;

    // Only one preferred source per novel — the UI reads with LIMIT 1
    conn.execute(
        "UPDATE sources SET is_preferred = 0 WHERE novel_id = ?1",
        rusqlite::params![payload.novel_id],
    ).map_err(|e| e.to_string())?;

    // Upsert source — update last_seen_url
    conn.execute(
        "INSERT INTO sources (novel_id, domain, url_pattern, last_seen_url, last_seen_at, is_preferred)
         VALUES (?1, ?2, ?2, ?3, datetime('now'), 1)
         ON CONFLICT(novel_id, domain) DO UPDATE SET
           last_seen_url=excluded.last_seen_url,
           last_seen_at=excluded.last_seen_at",
        rusqlite::params![payload.novel_id, payload.domain, payload.source_url],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

fn save_mapping(db_path: &str, payload: &MappingPayload) -> Result<(), String> {
    let conn = open_db(db_path)?;
    
    conn.execute(
        "INSERT INTO site_mappings (domain, detected_title, novel_id, confirmed_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(domain, detected_title) DO UPDATE SET
           novel_id=excluded.novel_id,
           confirmed_at=excluded.confirmed_at",
        rusqlite::params![payload.domain, payload.detected_title, payload.novel_id],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

fn parse_chapter_sort(raw: &str) -> Option<f64> {
    let lower = raw.to_lowercase();
    
    if let Some(caps) = regex_find(r"chapter\s*(\d+\.?\d*)", &lower) {
        return caps.parse().ok();
    }
    if let Some(caps) = regex_find(r"episode\s*(\d+)", &lower) {
        return caps.parse().ok();
    }
    if raw.trim().parse::<f64>().is_ok() {
        return raw.trim().parse().ok();
    }
    None
}

// Simple regex-free number extraction to avoid adding regex dependency
fn regex_find(pattern_hint: &str, text: &str) -> Option<String> {
    let keyword = if pattern_hint.contains("chapter") { "chapter" }
                  else if pattern_hint.contains("episode") { "episode" }
                  else { return None };
    
    if let Some(pos) = text.find(keyword) {
        let after = &text[pos + keyword.len()..];
        let trimmed = after.trim_start_matches(|c: char| c == ' ' || c == '\t');
        let num: String = trimmed.chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if !num.is_empty() { return Some(num); }
    }
    None
}

// ── Fuzzy matching (mirrors AddNovelPanel / extension background.js) ──────────
fn normalise(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];

    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

fn similarity(a: &str, b: &str) -> f64 {
    let na = normalise(a);
    let nb = normalise(b);
    if na.is_empty() || nb.is_empty() {
        return 0.0;
    }
    if na == nb {
        return 1.0;
    }
    let dist = levenshtein(&na, &nb) as f64;
    let max_len = na.chars().count().max(nb.chars().count()) as f64;
    1.0 - (dist / max_len)
}

/// An existing novel that the incoming title probably refers to
fn find_similar_novel(
    conn: &rusqlite::Connection,
    title: &str,
) -> Result<Option<(i64, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.canonical_title, a.alias
             FROM novels n
             LEFT JOIN aliases a ON a.novel_id = n.id
             ORDER BY n.id",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for (id, canonical, alias) in rows.filter_map(|r| r.ok()) {
        let matches_alias = alias
            .map(|a| similarity(title, &a) >= DUPLICATE_THRESHOLD)
            .unwrap_or(false);

        if matches_alias || similarity(title, &canonical) >= DUPLICATE_THRESHOLD {
            return Ok(Some((id, canonical)));
        }
    }

    Ok(None)
}

enum QuickAddResult {
    Added(i64),
    Duplicate { id: i64, title: String },
}

fn quick_add_novel(db_path: &str, payload: &QuickAddPayload) -> Result<QuickAddResult, String> {
    let conn = open_db(db_path)?;

    // The extension's candidate list can be minutes stale, and the same novel
    // is often titled differently per site — refuse to create a second row.
    if let Some((id, title)) = find_similar_novel(&conn, &payload.title)? {
        return Ok(QuickAddResult::Duplicate { id, title });
    }

    conn.execute(
        "INSERT INTO novels (canonical_title, status, notes, cover_url)
         VALUES (?1, 'planned', '', '')",
        rusqlite::params![payload.title],
    ).map_err(|e| e.to_string())?;
    
    let id = conn.last_insert_rowid();
    
    if !payload.chapter_raw.is_empty() {
        let chapter_sort: Option<f64> = parse_chapter_sort(&payload.chapter_raw);
        conn.execute(
            "INSERT INTO progress (novel_id, chapter_raw, chapter_sort, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))",
            rusqlite::params![id, payload.chapter_raw, chapter_sort],
        ).map_err(|e| e.to_string())?;
    }
    
    Ok(QuickAddResult::Added(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similarity_mirrors_the_frontend_rule() {
        // Same novel, punctuation/typography differences
        assert!(similarity("Editor\u{2019}s Survival Guide", "Editors Survival Guide") >= DUPLICATE_THRESHOLD);
        assert_eq!(similarity("Shadow Slave", "shadow slave!"), 1.0);
        // Different novels must not be treated as duplicates
        assert!(similarity("Shadow Slave", "Editor\u{2019}s Survival Guide") < DUPLICATE_THRESHOLD);
        assert!(similarity("", "Shadow Slave") < DUPLICATE_THRESHOLD);
    }

    #[test]
    fn normalise_matches_the_ts_implementation() {
        // Background.js: s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim()
        assert_eq!(normalise("  Editor\u{2019}s  Survival-Guide! "), "editors survivalguide");
        assert_eq!(normalise("TBATE: The Beginning"), "tbate the beginning");
    }

    #[test]
    fn api_header_gate() {
        // Header names are case-insensitive on the wire
        assert!(is_api_header("x-noveltrackr", "1"));
        assert!(is_api_header("X-Noveltrackr", "1"));
        assert!(!is_api_header("X-Noveltrackr", ""));
        assert!(!is_api_header("Origin", "1"));
    }

    /// The gate has to let the extension through and turn everyone else away —
    /// a false negative here would break the extension completely.
    #[test]
    fn server_requires_the_api_header() {
        let port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            probe.local_addr().unwrap().port()
        };

        // /status never touches the DB, so a throwaway path is fine here
        start_server_on(":memory:".to_string(), &format!("127.0.0.1:{}", port));

        let mut up = false;
        for _ in 0..50 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                up = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(up, "server never came up on port {}", port);

        let (unauthed_status, _) = http_get(port, false);
        assert_eq!(unauthed_status, 403, "requests from other origins must be refused");

        let (authed_status, body) = http_get(port, true);
        assert_eq!(authed_status, 200, "the extension's requests must get through");
        assert!(body.contains("running"));
    }

    fn http_get(port: u16, with_header: bool) -> (u16, String) {
        use std::io::{Read, Write};

        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();

        let auth = if with_header { "X-Noveltrackr: 1\r\n" } else { "" };
        let request = format!(
            "GET /status HTTP/1.1\r\nHost: 127.0.0.1\r\n{}Connection: close\r\n\r\n",
            auth
        );
        stream.write_all(request.as_bytes()).unwrap();

        let mut raw = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => raw.extend_from_slice(&buf[..n]),
                Err(_) => break, // read timeout — the status line is already in
            }
        }

        let text = String::from_utf8_lossy(&raw).to_string();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        (status, text)
    }

    #[test]
    fn chapter_sort_extraction() {
        assert_eq!(parse_chapter_sort("Chapter 221"), Some(221.0));
        assert_eq!(parse_chapter_sort("chapter 12.5"), Some(12.5));
        assert_eq!(parse_chapter_sort("Episode 4"), Some(4.0));
        assert_eq!(parse_chapter_sort("12.5"), Some(12.5));
        assert_eq!(parse_chapter_sort("Vol 2 Ch 4"), None);
    }
}