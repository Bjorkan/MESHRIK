use std::{collections::HashMap, fs, process::Command};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use meshrik_backend::{config::Config, lifecycle::ProcessLease, router};
use tempfile::TempDir;
use tower::ServiceExt;

fn environment(directory: &TempDir) -> HashMap<String, String> {
    HashMap::from([
        ("MESHRIK_RUST_FIXTURE".into(), "1".into()),
        (
            "MESHRIK_RUST_FIXTURE_DIR".into(),
            directory.path().display().to_string(),
        ),
        (
            "MESHRIK_RUST_FRONTEND_DIR".into(),
            directory.path().display().to_string(),
        ),
    ])
}

#[test]
fn configuration_fails_closed() {
    assert!(Config::parse(&HashMap::new()).is_err());
    let directory = TempDir::new().unwrap();
    let env = environment(&directory);
    assert!(Config::parse(&env).is_ok());
    for (key, value) in [
        ("MESHRIK_RUST_LISTEN", "0.0.0.0:8001"),
        ("MESHCORE_SERIAL_PORT", "/dev/fixture"),
        ("MESHCORE_TCP_HOST", "127.0.0.1"),
        ("MESHCORE_BLE_ADDRESS", "fixture"),
        ("MESHCORE_BASIC_AUTH_PASSWORD", "synthetic"),
        ("MESHCORE_STARTUP_POLICY", "passive"),
    ] {
        let mut invalid = env.clone();
        invalid.insert(key.into(), value.into());
        assert!(Config::parse(&invalid).is_err(), "{key}");
    }
}

#[test]
fn lease_excludes_another_owner_and_releases_without_unlink() {
    let directory = TempDir::new().unwrap();
    let database = directory.path().join("fixture.db");
    let first = ProcessLease::acquire(&database).unwrap();
    assert!(ProcessLease::acquire(&database).is_err());
    drop(first);
    assert!(database.with_extension("db.radio-owner.lock").exists());
    assert!(ProcessLease::acquire(&database).is_ok());
    assert!(!database.exists());
}

#[test]
#[cfg(unix)]
fn lease_is_compatible_with_python_flock() {
    let directory = TempDir::new().unwrap();
    let database = directory.path().join("fixture.db");
    let lease = ProcessLease::acquire(&database).unwrap();
    // Same fcntl.flock call as RadioProcessLease, no app import or resources.
    let probe = || {
        Command::new("python3").arg("-c").arg(
        "import fcntl,sys; f=open(sys.argv[1]+'.radio-owner.lock','a+'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)"
    ).arg(&database).output().unwrap().status.success()
    };
    assert!(!probe());
    drop(lease);
    assert!(probe());
}

#[tokio::test]
async fn health_is_explicitly_unready_and_api_is_not_a_spa() {
    let directory = TempDir::new().unwrap();
    fs::write(directory.path().join("index.html"), "<head></head>fixture").unwrap();
    let app = router(Config::parse(&environment(&directory)).unwrap(), None);
    let response = app
        .clone()
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()["x-request-id"].len(), 32);
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"readiness":"fixture", "database_open":false, "radio_open":false, "integrations_started":false})
    );
    for path in ["/api/messages", "/api/ws", "/api", "/api/unknown"] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED, "{path}");
    }
}

#[tokio::test]
async fn auth_covers_http_ws_docs_and_static() {
    let directory = TempDir::new().unwrap();
    let mut env = environment(&directory);
    env.insert("MESHCORE_BASIC_AUTH_USERNAME".into(), "fixture".into());
    env.insert("MESHCORE_BASIC_AUTH_PASSWORD".into(), "synthetic".into());
    let app = router(Config::parse(&env).unwrap(), None);
    for path in [
        "/api/health",
        "/api/ws",
        "/docs",
        "/openapi.json",
        "/",
        "/assets/a.js",
    ] {
        for auth in ["", "Basic !invalid!", "Bearer ignored"] {
            let response = app
                .clone()
                .oneshot(
                    Request::get(path)
                        .header("authorization", auth)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(
                response.headers()["www-authenticate"],
                "Basic realm=\"MESHRIK\", charset=\"UTF-8\""
            );
        }
    }
    let response = app
        .oneshot(
            Request::get("/api/ws")
                .header(
                    "authorization",
                    format!("Basic {}", STANDARD.encode("fixture:synthetic")),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
}

#[tokio::test]
async fn static_spa_and_ingress_have_correct_base_and_cache() {
    let directory = TempDir::new().unwrap();
    fs::write(
        directory.path().join("index.html"),
        "<head><link rel=\"manifest\" href=\"site.webmanifest\"></head>fixture",
    )
    .unwrap();
    fs::create_dir(directory.path().join("assets")).unwrap();
    fs::write(directory.path().join("assets/a.js"), "fixture").unwrap();
    fs::write(directory.path().join("sw.js"), "fixture-worker").unwrap();
    let app = router(Config::parse(&environment(&directory)).unwrap(), None);
    for path in ["/", "/index.html", "/channels/fixture"] {
        let response = app
            .clone()
            .oneshot(
                Request::get(path)
                    .header("x-ingress-path", "/api/hassio_ingress/fixture/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let html = String::from_utf8(to_bytes(response.into_body(), 4096).await.unwrap().to_vec())
            .unwrap();
        assert!(html.contains("<base href=\"/api/hassio_ingress/fixture/\">"));
        assert!(!html.contains("rel=\"manifest\""));
    }
    for (path, cache) in [
        ("/assets/a.js", "public, max-age=31536000, immutable"),
        ("/sw.js", "public, max-age=3600"),
    ] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], cache);
    }
    let response = app
        .oneshot(
            Request::get("/assets/missing.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn manifest_uses_proxy_origin_and_ingress_scope() {
    let directory = TempDir::new().unwrap();
    let app = router(Config::parse(&environment(&directory)).unwrap(), None);
    let response = app
        .oneshot(
            Request::get("/site.webmanifest")
                .header("x-forwarded-proto", "https")
                .header("x-forwarded-host", "fixture.invalid")
                .header("x-ingress-path", "/api/hassio_ingress/fixture")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.headers()["content-type"],
        "application/manifest+json"
    );
    let value: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(
        value["scope"],
        "https://fixture.invalid/api/hassio_ingress/fixture/"
    );
    assert_eq!(value["icons"].as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn invalid_ingress_is_not_reflected_and_large_responses_are_gzipped() {
    let directory = TempDir::new().unwrap();
    fs::write(
        directory.path().join("index.html"),
        format!("<head></head>{}", "fixture".repeat(200)),
    )
    .unwrap();
    let app = router(Config::parse(&environment(&directory)).unwrap(), None);
    let response = app
        .clone()
        .oneshot(
            Request::get("/channels/fixture")
                .header("x-ingress-path", "/api/hassio_ingress/fixture/<script>")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body =
        String::from_utf8(to_bytes(response.into_body(), 4096).await.unwrap().to_vec()).unwrap();
    assert!(body.contains("<base href=\"/\">"));
    assert!(!body.contains("<script>"));
    let response = app
        .oneshot(
            Request::get("/")
                .header("accept-encoding", "gzip")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["content-encoding"], "gzip");
}

#[tokio::test]
#[cfg(unix)]
async fn static_symlinks_cannot_escape_the_frontend_directory() {
    let directory = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("fixture.txt"), "outside-fixture").unwrap();
    std::os::unix::fs::symlink(outside.path(), directory.path().join("escape")).unwrap();
    let app = router(Config::parse(&environment(&directory)).unwrap(), None);
    for path in ["/escape/fixture.txt", "/escape%2Ffixture.txt"] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn cors_preflight_precedes_auth_and_preserves_trusted_network_policy() {
    let directory = TempDir::new().unwrap();
    let mut env = environment(&directory);
    env.insert("MESHCORE_BASIC_AUTH_USERNAME".into(), "fixture".into());
    env.insert("MESHCORE_BASIC_AUTH_PASSWORD".into(), "synthetic".into());
    let app = router(Config::parse(&env).unwrap(), None);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/messages")
                .header("origin", "https://fixture.invalid")
                .header("access-control-request-method", "POST")
                .header("access-control-request-headers", "authorization")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "https://fixture.invalid"
    );
    assert_eq!(
        response.headers()["access-control-allow-credentials"],
        "true"
    );
    let response = app
        .oneshot(
            Request::get("/api/health")
                .header("origin", "https://fixture.invalid")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
}
