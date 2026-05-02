use tiny_http::{Server, Response, Header, Method};
use serde::{Deserialize, Serialize};

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
#[allow(dead_code)]
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

// The DB handle gets passed in from main
pub fn start_server(
    db_path: String,
) {
    std::thread::spawn(move || {
        let server = Server::http("127.0.0.1:39172").expect("Failed to start local server");
        
        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            
            // Handle CORS preflight
            if method == Method::Options {
                let _ = request.respond(json_response("{}".to_string(), 200));
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

                _ => json_response(r#"{"error":"not found"}"#.to_string(), 404),
            };

            let _ = request.respond(response);
        }
    });
}

// ── Direct SQLite operations for the server thread ────────────────────────────
// These use rusqlite directly since we can't use tauri-plugin-sql from a thread

fn get_novels_for_extension(db_path: &str) -> Result<Vec<NovelSummary>, String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
    let mut stmt = conn.prepare(
        "SELECT n.id, n.canonical_title, p.chapter_raw
         FROM novels n
         LEFT JOIN progress p ON p.novel_id = n.id"
    ).map_err(|e| e.to_string())?;

    let novels: Vec<(i64, String, Option<String>)> = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
    .map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    let mut result = Vec::new();
    for (id, title, chapter) in novels {
        let mut alias_stmt = conn.prepare(
            "SELECT alias FROM aliases WHERE novel_id = ?"
        ).map_err(|e| e.to_string())?;
        
        let aliases: Vec<String> = alias_stmt.query_map([id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        result.push(NovelSummary {
            id,
            canonical_title: title,
            aliases,
            current_chapter_raw: chapter,
        });
    }
    
    Ok(result)
}

fn update_progress_and_source(db_path: &str, payload: &UpdateProgressPayload) -> Result<(), String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
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
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
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