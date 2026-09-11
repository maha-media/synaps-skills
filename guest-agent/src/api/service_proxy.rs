//! Authenticated, bounded data plane. Never exports upstream headers or ports.
use crate::{
    api::AppState,
    error::GuestAgentError,
    services::{ServiceKind, ServiceState},
};
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::StatusCode,
    response::Response,
};
use std::time::Duration;
const MAX_BODY: usize = 16 * 1024 * 1024;
pub async fn proxy(
    State(state): State<AppState>,
    mut req: Request,
) -> Result<Response, GuestAgentError> {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();
    let upgrade = if headers.contains_key("upgrade") {
        Some(hyper::upgrade::on(&mut req))
    } else {
        None
    };
    let body = to_bytes(req.into_body(), 1024)
        .await
        .map_err(|_| GuestAgentError::invalid_request("request body too large"))?;
    state.hmac.verify(
        method.as_str(),
        uri.path(),
        uri.query().unwrap_or(""),
        &headers,
        &body,
    )?;
    if !body.is_empty() {
        return Err(GuestAgentError::invalid_request(
            "proxy request body forbidden",
        ));
    }
    let prefix = format!("{}/services/", state.config.route_prefix);
    let tail = uri
        .path()
        .strip_prefix(&prefix)
        .ok_or_else(|| GuestAgentError::invalid_request("invalid proxy route"))?;
    let (id, tail) = tail
        .split_once("/proxy/")
        .ok_or_else(|| GuestAgentError::invalid_request("invalid proxy route"))?;
    let (generation, path) = tail.split_once('/').unwrap_or((tail, ""));
    let decoded_path = decode_proxy_path(path).map_err(GuestAgentError::invalid_request)?;
    let path = decoded_path.as_str();
    let generation = generation
        .parse::<u64>()
        .map_err(|_| GuestAgentError::invalid_request("invalid generation"))?;
    let nonce = headers
        .get("x-pria-nonce")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if let Some(upgrade) = upgrade {
        return websocket(
            &state,
            id,
            generation,
            path,
            uri.query(),
            &headers,
            nonce,
            upgrade,
        )
        .await;
    }
    let result = {
        tokio::time::timeout(
            Duration::from_secs(15),
            fetch(
                &state,
                id,
                generation,
                path,
                uri.query(),
                method == axum::http::Method::HEAD,
                &headers,
            ),
        )
        .await
        .unwrap_or(Err("upstream timeout"))
    };
    let result = result.and_then(|r| {
        if r.2.len() > MAX_BODY {
            Err("response too large")
        } else {
            Ok(r)
        }
    });
    let (status, mime, mut bytes) =
        result.unwrap_or((503, "text/plain".into(), b"Service unavailable".to_vec()));
    if method == axum::http::Method::HEAD {
        bytes.clear();
    }
    let proof = state
        .hmac
        .service_proof(nonce, id, generation, status, &bytes);
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY))
        .header("content-type", mime)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("x-pria-service-proof", proof)
        .body(Body::from(bytes))
        .map_err(|_| GuestAgentError::internal("response construction failed"))
}
async fn fetch(
    state: &AppState,
    id: &str,
    generation: u64,
    path: &str,
    query: Option<&str>,
    head: bool,
    headers: &axum::http::HeaderMap,
) -> Result<(u16, String, Vec<u8>), &'static str> {
    if state.services.retained.status(id).is_some() {
        let services = state.services.clone();
        let id = id.to_owned();
        let path = path.to_owned();
        let html = headers
            .get("accept")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').any(|s| s.trim() == "text/html"))
            .unwrap_or(false);
        return tokio::task::spawn_blocking(move || {
            services.retained.serve_html(&id, generation, &path, html)
        })
        .await
        .map_err(|_| "adapter failed")?
        .map_err(|_| "release unavailable");
    }
    let entry = state.services.get(id).ok_or("unknown service")?;
    if entry.kind != ServiceKind::Dev
        || entry.generation != generation
        || entry.state() != ServiceState::Ready
    {
        return Err("generation unavailable");
    }
    if path.contains(['\\', '#']) || path.split('/').any(|s| s == ".." || s == ".") {
        return Err("unsafe path");
    }
    let url = dev_url(&entry, path, query)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "client unavailable")?;
    let mut request = client.request(
        if head {
            reqwest::Method::HEAD
        } else {
            reqwest::Method::GET
        },
        url,
    );
    for name in ["accept", "accept-language"] {
        if let Some(v) = headers.get(name) {
            request = request.header(name, v);
        }
    }
    let mut response = request.send().await.map_err(|_| "upstream unavailable")?;
    if response.status().is_redirection() || response.headers().contains_key("set-cookie") {
        return Err("upstream redirect/cookie refused");
    }
    let status = response.status().as_u16();
    let mime = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    if response.content_length().unwrap_or(0) > MAX_BODY as u64 {
        return Err("response too large");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "upstream body failed")? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("response too large");
        }
        body.extend_from_slice(&chunk);
    }
    if entry.state() != ServiceState::Ready
        || state.services.get(id).map(|s| s.generation) != Some(generation)
    {
        return Err("generation changed");
    }
    Ok((status, mime, body))
}

async fn websocket(
    state: &AppState,
    id: &str,
    generation: u64,
    path: &str,
    query: Option<&str>,
    headers: &axum::http::HeaderMap,
    nonce: &str,
    downstream: hyper::upgrade::OnUpgrade,
) -> Result<Response, GuestAgentError> {
    let unavailable = || GuestAgentError::invalid_request("WebSocket service unavailable");
    let entry = state.services.get(id).ok_or_else(unavailable)?;
    if entry.kind != ServiceKind::Dev
        || entry.generation != generation
        || entry.state() != ServiceState::Ready
    {
        return Err(unavailable());
    }
    if headers
        .get("upgrade")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("websocket"))
        != Some(true)
        || headers
            .get("sec-websocket-version")
            .and_then(|h| h.to_str().ok())
            != Some("13")
        || path.contains(['\\', '#'])
        || path.split('/').any(|s| s == ".." || s == ".")
    {
        return Err(unavailable());
    }
    let key = headers.get("sec-websocket-key").ok_or_else(unavailable)?;
    use base64::Engine;
    if base64::engine::general_purpose::STANDARD
        .decode(key.as_bytes())
        .map(|b| b.len())
        .ok()
        != Some(16)
    {
        return Err(unavailable());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| unavailable())?;
    let url = dev_url(&entry, path, query).map_err(|_| unavailable())?;
    let mut request = client
        .get(url)
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", key);
    if let Some(protocol) = headers.get("sec-websocket-protocol") {
        request = request.header("sec-websocket-protocol", protocol);
    }
    let response = request.send().await.map_err(|_| unavailable())?;
    if response.status().as_u16() != 101
        || response.headers().contains_key("set-cookie")
        || response.headers().contains_key("location")
        || response.headers().contains_key("sec-websocket-extensions")
    {
        return Err(unavailable());
    }
    let accept = response
        .headers()
        .get("sec-websocket-accept")
        .ok_or_else(unavailable)?
        .clone();
    let protocol = response.headers().get("sec-websocket-protocol").cloned();
    if let Some(ref p) = protocol {
        let offered = headers
            .get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !offered
            .split(',')
            .any(|v| v.trim() == p.to_str().unwrap_or("\n"))
        {
            return Err(unavailable());
        }
    }
    let upstream = response.upgrade().await.map_err(|_| unavailable())?;
    let proof = state.hmac.service_proof(nonce, id, generation, 101, b"");
    let services = state.services.clone();
    let id = id.to_owned();
    tokio::spawn(async move {
        if let Ok(downstream) = downstream.await {
            let mut downstream = hyper_util::rt::TokioIo::new(downstream);
            let mut upstream = upstream;
            // Hard connection lease bounds revocation even if gateway disconnect is lost.
            let fence = async {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
                loop {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    if tokio::time::Instant::now() >= deadline
                        || services
                            .get(&id)
                            .map(|e| e.generation == generation && e.state() == ServiceState::Ready)
                            != Some(true)
                    {
                        break;
                    }
                }
            };
            tokio::select! {_ = tokio::io::copy_bidirectional(&mut downstream,&mut upstream)=>{},_ = fence=>{}}
        }
    });
    let mut response = Response::builder()
        .status(101)
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-accept", accept)
        .header("x-pria-service-proof", proof)
        .header("cache-control", "no-store");
    if let Some(p) = protocol {
        response = response.header("sec-websocket-protocol", p);
    }
    response.body(Body::empty()).map_err(|_| unavailable())
}

/// Decode only after HMAC verification of the original wire URI. Reject
/// double encoding and escaped structural bytes; never normalize traversal.
fn decode_proxy_path(raw: &str) -> Result<String, &'static str> {
    if raw.len() > 4096 || raw.starts_with('/') {
        return Err("unsafe proxy path");
    }
    let mut decoded = Vec::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = if bytes[i] == b'%' {
            let pair = bytes.get(i + 1..i + 3).ok_or("invalid path escape")?;
            let digit = |b: u8| {
                (b as char)
                    .to_digit(16)
                    .map(|v| v as u8)
                    .ok_or("invalid path escape")
            };
            let value = digit(pair[0])? * 16 + digit(pair[1])?;
            if b"/\\.%?#".contains(&value) {
                return Err("escaped path structure");
            }
            i += 3;
            value
        } else {
            let value = bytes[i];
            i += 1;
            value
        };
        if b <= 0x20 || b >= 0x7f || b"\\?#%".contains(&b) {
            return Err("unsafe proxy path byte");
        }
        decoded.push(b);
    }
    let decoded = String::from_utf8(decoded).map_err(|_| "invalid path encoding")?;
    if decoded.split('/').any(|s| s == "." || s == "..") || decoded.contains("//") {
        return Err("unsafe proxy path segment");
    }
    Ok(decoded)
}

/// Append only stripped relative paths to the immutable authenticated start base.
/// Reject URL normalization ambiguities rather than escaping the owning base.
fn dev_url(
    entry: &crate::services::ServiceEntry,
    path: &str,
    query: Option<&str>,
) -> Result<String, &'static str> {
    let base = &entry.revision_base;
    if !safe_dev_base(base)
        || path.starts_with('/')
        || path.contains(['\\', '#', '?'])
        || path.split('/').any(|s| s == "." || s == "..")
        || path.to_ascii_lowercase().contains("%2e")
        || path.to_ascii_lowercase().contains("%2f")
        || path.to_ascii_lowercase().contains("%5c")
    {
        return Err("unsafe dev base/path");
    }
    Ok(format!(
        "http://127.0.0.1:{}{}{}{}",
        entry.port,
        base,
        path,
        query.map(|q| format!("?{q}")).unwrap_or_default()
    ))
}

fn safe_dev_base(base: &str) -> bool {
    base.starts_with('/')
        && base.ends_with('/')
        && !base.contains("//")
        && base
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_.".contains(&b))
        && !base.split('/').any(|s| s == "." || s == "..")
}

#[cfg(test)]
mod base_tests {
    use super::{decode_proxy_path, safe_dev_base};
    #[test]
    fn authenticated_path_single_decode() {
        assert_eq!(decode_proxy_path("%40vite/client").unwrap(), "@vite/client");
        assert_eq!(decode_proxy_path("@vite/client").unwrap(), "@vite/client");
        assert_eq!(decode_proxy_path("src/main.tsx").unwrap(), "src/main.tsx");
        for path in [
            "../x",
            "a/./x",
            "%2e%2e/x",
            "a%2fb",
            "a%5Cb",
            "%2540vite/client",
            "%00",
            "%0a",
            "%",
            "%gg",
            "/x",
            "a//b",
            "a?b",
            "%23x",
        ] {
            assert!(decode_proxy_path(path).is_err(), "accepted {path}");
        }
    }
    #[test]
    fn dotted_segments_are_not_traversal_or_arbitrary_urls() {
        assert!(safe_dev_base("/pid/d/v3d.eyJpZCI6MX0.ABCdef0123_-/"));
        for base in [
            "/pid/./cap/",
            "/pid/../cap/",
            "/pid/%2e/cap/",
            "/pid/a%20b/",
            "/pid/a\\b/",
            "/pid/cap/?q=1",
            "/pid/cap/#hash",
            "https://example.com/",
            "//example.com/",
            "/pid//cap/",
            "relative/",
        ] {
            assert!(!safe_dev_base(base), "accepted {base}");
        }
    }
}
