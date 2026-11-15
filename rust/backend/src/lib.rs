pub mod config;
pub mod lifecycle;
pub mod storage;

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use config::Config;
use lifecycle::RuntimeStatus;
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use subtle::ConstantTimeEq;
use tower_http::{
    compression::{CompressionLayer, predicate::SizeAbove},
    services::ServeDir,
};
use uuid::Uuid;

struct AppState {
    frontend_dir: PathBuf,
    basic_auth: Option<(String, String)>,
    storage: Option<Arc<storage::Storage>>,
}

pub fn router(config: Config, storage: Option<Arc<storage::Storage>>) -> Router {
    let static_files = ServeDir::new(config.frontend_dir.clone());
    let assets = ServeDir::new(config.frontend_dir.join("assets"));
    let state = Arc::new(AppState {
        frontend_dir: config.frontend_dir,
        basic_auth: config.basic_auth,
        storage,
    });
    Router::new()
        .route("/api/health", get(health))
        .route("/api/{*path}", axum::routing::any(unimplemented))
        .route("/api", axum::routing::any(unimplemented))
        .route("/openapi.json", get(openapi))
        .route("/docs", get(docs))
        .route("/", get(spa))
        .route("/index.html", get(spa))
        .route("/site.webmanifest", get(manifest))
        .nest_service("/assets", assets)
        .fallback_service(static_files.fallback(get(spa).with_state(state.clone())))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            static_boundary,
        ))
        .layer(middleware::from_fn_with_state(state.clone(), basic_auth))
        .layer(CompressionLayer::new().compress_when(SizeAbove::new(500)))
        .layer(middleware::from_fn(cors))
        .layer(middleware::from_fn(request_context))
        .with_state(state)
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Not a production readiness claim or a substitute for HealthResponse parity.
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(RuntimeStatus {
            database_open: state.storage.is_some(),
            ..RuntimeStatus::default()
        }),
    )
}

async fn unimplemented() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"detail": "Rust fixture backend: operation not implemented"})),
    )
}

async fn openapi() -> impl IntoResponse {
    // Publish only implemented fixture operations. The complete Python reference
    // remains in tests/fixtures; serving it here would falsely claim API parity.
    Json(json!({
        "openapi": "3.1.0", "info": {"title": "MESHRIK Rust fixture backend", "version": "0.1.0"},
        "paths": {"/api/health": {"get": {"responses": {"503": {"description": "Fixture mode; native storage may be open; radio and integrations unavailable"}}}}}
    }))
}

async fn docs() -> Html<&'static str> {
    Html(
        "<!doctype html><html><head><title>MESHRIK fixture API</title></head><body><h1>MESHRIK Rust fixture API</h1><p>Migration in progress. Native storage is available in fixture mode. No radio or integrations are connected.</p><a href='/openapi.json'>OpenAPI JSON</a></body></html>",
    )
}

async fn spa(State(state): State<Arc<AppState>>, request: Request) -> Response {
    // ServeDir validates static traversal. SPA fallback never includes requested
    // paths in filesystem reads, and /api has an explicit unavailable handler.
    match tokio::fs::read_to_string(state.frontend_dir.join("index.html")).await {
        Ok(mut html) => {
            let ingress = request
                .headers()
                .get("x-ingress-path")
                .and_then(|value| value.to_str().ok());
            let base = ingress.and_then(ingress_base).unwrap_or_else(|| "/".into());
            if html.contains("<base href=\"/\"") {
                html = html.replacen("<base href=\"/\"", &format!("<base href=\"{base}\""), 1);
            } else {
                html = html.replacen("<head>", &format!("<head><base href=\"{base}\">"), 1);
            }
            if base != "/"
                && let Some(start) = html.find("<link rel=\"manifest\"")
                && let Some(end) = html[start..].find('>')
            {
                html.replace_range(start..=start + end, "");
            }
            let mut response = Html(html).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({"detail": "Frontend not built"})),
        )
            .into_response(),
    }
}

fn ingress_base(value: &str) -> Option<String> {
    let suffix = value.strip_prefix("/api/hassio_ingress/")?;
    let token = suffix.strip_suffix('/').unwrap_or(suffix);
    if token.is_empty()
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    Some(format!("/api/hassio_ingress/{token}/"))
}

async fn static_boundary(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if !path.starts_with("/api") && !matches!(path, "/docs" | "/openapi.json") {
        let decoded = percent_encoding::percent_decode_str(path).decode_utf8();
        let Ok(decoded) = decoded else {
            return StatusCode::NOT_FOUND.into_response();
        };
        if let (Ok(root), Ok(target)) = (
            tokio::fs::canonicalize(&state.frontend_dir).await,
            tokio::fs::canonicalize(state.frontend_dir.join(decoded.trim_start_matches('/'))).await,
        ) && !target.starts_with(root)
        {
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    next.run(request).await
}

async fn manifest(request: Request) -> Response {
    let headers = request.headers();
    let first = |key: &str| {
        headers
            .get(key)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let origin = match (first("x-forwarded-proto"), first("x-forwarded-host")) {
        (Some(proto), Some(host)) => format!("{proto}://{host}"),
        _ => format!("http://{}", first("host").unwrap_or("localhost")),
    };
    let path = first("x-ingress-path")
        .and_then(ingress_base)
        .unwrap_or_else(|| "/".into());
    let base = format!("{origin}{path}");
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("../../../frontend/public/site.webmanifest"))
            .expect("committed manifest JSON");
    for field in ["id", "start_url", "scope"] {
        value[field] = json!(base);
    }
    for field in ["icons", "screenshots"] {
        for item in value[field].as_array_mut().expect("manifest array") {
            let source = item["src"].as_str().expect("manifest src");
            item["src"] = json!(format!("{base}{}", source.trim_start_matches('/')));
        }
    }
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/manifest+json"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn cors(request: Request, next: Next) -> Response {
    let origin = request.headers().get(header::ORIGIN).cloned();
    let has_cookie = request.headers().contains_key(header::COOKIE);
    let preflight = request.method() == axum::http::Method::OPTIONS
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
        && origin.is_some();
    let mut response = if preflight {
        let method = request
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_METHOD)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let allowed =
            ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].contains(&method);
        let mut response = (
            if allowed {
                StatusCode::OK
            } else {
                StatusCode::BAD_REQUEST
            },
            if allowed {
                "OK"
            } else {
                "Disallowed CORS method"
            },
        )
            .into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT"),
        );
        headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        if let Some(requested) = request
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        {
            headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, requested.clone());
        }
        response
    } else {
        next.run(request).await
    };
    if let Some(origin) = origin {
        let headers = response.headers_mut();
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        if preflight || has_cookie {
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            headers.append(header::VARY, HeaderValue::from_static("Origin"));
        } else {
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_static("*"),
            );
        }
    }
    response
}

async fn basic_auth(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    if let Some((username, password)) = &state.basic_auth {
        let authorized = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split_once(' '))
            .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("basic"))
            .and_then(|(_, token)| STANDARD.decode(token.trim()).ok())
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|value| {
                value
                    .split_once(':')
                    .map(|(u, p)| (u.to_owned(), p.to_owned()))
            })
            .map(|(u, p)| {
                bool::from(
                    u.as_bytes().ct_eq(username.as_bytes())
                        & p.as_bytes().ct_eq(password.as_bytes()),
                )
            })
            .unwrap_or(false);
        if !authorized {
            let mut response = (
                StatusCode::UNAUTHORIZED,
                Json(json!({"detail": "Unauthorized"})),
            )
                .into_response();
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static("Basic realm=\"MESHRIK\", charset=\"UTF-8\""),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            return response;
        }
    }
    next.run(request).await
}

async fn request_context(request: Request, next: Next) -> Response<Body> {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    if response.status().is_success()
        && !response.headers().contains_key(header::CACHE_CONTROL)
        && !path.starts_with("/api")
        && !matches!(path.as_str(), "/docs" | "/openapi.json")
    {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(if path.starts_with("/assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "public, max-age=3600"
            }),
        );
    }
    response.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&Uuid::new_v4().simple().to_string())
            .expect("UUID is a header value"),
    );
    response
}
