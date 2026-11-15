# Rust migration

Inherits root guidance. Python remains the production reference until #275's
cutover gate. Foundation code runs only with explicit fixture configuration;
never add production radio or DB access by relaxing that check.

- Native embedded `turso`, never libSQL/SQLx/rusqlite for production storage.
  #296 must pass before implementing #278/#279/#280.
- Keep exact crate pins and Cargo.lock. Run `cargo fmt --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- Hold the same `.radio-owner.lock` advisory lease as Python throughout resource
  ownership. Lock acquisition must precede any DB or radio access. Never unlink
  a lock file when releasing it.
- An unimplemented operation returns an explicit error; schema publication or
  a passing fake test does not establish runtime/hardware parity.
- `turso-probe` is a test-only byte-input/temp-file executable, separate from
  the HTTP backend. `scripts/quality/turso_gate.sh` checks reproducibility of
  recorded NO-GO evidence; a green check does not clear #296. Review the
  matrix and `docs/migration/TURSO_FEASIBILITY.md` before changing engine pins.
