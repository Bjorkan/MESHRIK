use std::{collections::HashMap, net::SocketAddr, path::PathBuf};

/// Typed bootstrap settings. Never derive Debug: credentials must stay private.
pub struct Config {
    pub listen: SocketAddr,
    pub fixture_dir: PathBuf,
    pub frontend_dir: PathBuf,
    pub basic_auth: Option<(String, String)>,
}

impl Config {
    pub fn from_env() -> Result<Self, &'static str> {
        Self::parse(&std::env::vars().collect())
    }

    pub fn parse(env: &HashMap<String, String>) -> Result<Self, &'static str> {
        let value = |key: &str| env.get(key).map(String::as_str).unwrap_or("");
        if value("MESHRIK_RUST_FIXTURE") != "1" {
            return Err(
                "Rust backend requires MESHRIK_RUST_FIXTURE=1; production cutover is gated",
            );
        }
        let directory = value("MESHRIK_RUST_FIXTURE_DIR");
        if directory.is_empty() {
            return Err("MESHRIK_RUST_FIXTURE_DIR must name a disposable fixture directory");
        }
        // Until #281 there is no transport implementation and no auto-detection.
        if [
            "MESHCORE_SERIAL_PORT",
            "MESHCORE_TCP_HOST",
            "MESHCORE_BLE_ADDRESS",
        ]
        .iter()
        .any(|key| !value(key).is_empty())
        {
            return Err("Physical radio configuration is unsupported in fixture mode");
        }
        if !matches!(value("MESHCORE_STARTUP_POLICY"), "" | "full") {
            return Err("Only full startup policy is supported");
        }
        let basic_auth = match (
            value("MESHCORE_BASIC_AUTH_USERNAME"),
            value("MESHCORE_BASIC_AUTH_PASSWORD"),
        ) {
            ("", "") => None,
            ("", _) | (_, "") => {
                return Err("Basic auth username and password must be set together");
            }
            (username, password) => Some((username.into(), password.into())),
        };
        let listen = match value("MESHRIK_RUST_LISTEN") {
            "" => "127.0.0.1:8001",
            address => address,
        }
        .parse::<SocketAddr>()
        .map_err(|_| "Invalid MESHRIK_RUST_LISTEN")?;
        if !listen.ip().is_loopback() {
            return Err("Fixture listener must use a loopback address");
        }
        Ok(Self {
            listen,
            fixture_dir: PathBuf::from(directory),
            frontend_dir: match value("MESHRIK_RUST_FRONTEND_DIR") {
                "" => PathBuf::from("frontend/dist"),
                directory => PathBuf::from(directory),
            },
            basic_auth,
        })
    }
}
