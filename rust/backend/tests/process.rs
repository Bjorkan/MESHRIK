#![cfg(unix)]

use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use meshrik_backend::lifecycle::ProcessLease;

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn binary_starts_stops_and_does_not_create_a_database() {
    let directory = tempfile::tempdir().unwrap();
    let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = reservation.local_addr().unwrap();
    drop(reservation);
    let mut server = Server(
        Command::new(env!("CARGO_BIN_EXE_meshrik-backend"))
            .env_clear()
            .env("MESHRIK_RUST_FIXTURE", "1")
            .env("MESHRIK_RUST_FIXTURE_DIR", directory.path())
            .env("MESHRIK_RUST_LISTEN", address.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut connection = loop {
        assert!(
            server.0.try_wait().unwrap().is_none(),
            "server exited before readiness"
        );
        if let Ok(stream) = TcpStream::connect(address) {
            break stream;
        }
        assert!(Instant::now() < deadline, "fixture startup timed out");
        thread::sleep(Duration::from_millis(10));
    };
    connection
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    connection
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    connection.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 503"));
    drop(connection);
    let database = directory.path().join("fixture.db");
    assert!(ProcessLease::acquire(&database).is_err());
    assert!(
        Command::new("kill")
            .args(["-TERM", &server.0.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = server.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline, "graceful shutdown timed out");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(ProcessLease::acquire(&database).is_ok());
    assert!(!database.exists());
}

#[test]
fn binary_refuses_production_startup() {
    let output = Command::new(env!("CARGO_BIN_EXE_meshrik-backend"))
        .env_clear()
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("MESHRIK_RUST_FIXTURE=1")
    );
}
