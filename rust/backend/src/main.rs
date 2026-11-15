use meshrik_backend::{config::Config, lifecycle::ProcessLease, router, storage::Storage};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_target(false).init();
    let config = Config::from_env()?;
    std::fs::create_dir_all(&config.fixture_dir)?;
    // Acquire before any resources, and retain until HTTP shutdown completes.
    let lease = ProcessLease::acquire(&config.fixture_dir.join("fixture.db"))?;
    let storage = Arc::new(Storage::open(lease).await?);
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(address = %listener.local_addr()?, "Rust fixture HTTP listener started");
    axum::serve(listener, router(config, Some(storage)))
        .with_graceful_shutdown(shutdown())
        .await?;
    tracing::info!("Rust fixture backend stopped");
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c()
        .await
        .expect("install Ctrl-C handler");
}
