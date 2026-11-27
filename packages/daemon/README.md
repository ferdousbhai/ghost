# `ghostd`

`ghostd` is Ghost's owner-local control plane. It owns ghost lifecycle,
the conversation, the local model and its loop, hooks,
authenticated HTTP/SSE, and the `ghost` terminal client. Each turn runs on a
model on this machine, whose tools are a shell and a question to the owner.

The stable storage and API contract is in
[`CONTRACTS.md`](../../CONTRACTS.md). This README covers local development.

## Local development

Run focused checks from the repository root:

```sh
cargo clippy -p ghostd --all-targets --locked -- -D warnings
cargo test -p ghostd --locked
```

The daemon is a native Rust binary. Tests must use a scratch ghost home and ephemeral port.
Never point a development daemon at `~/.local/share/ghost`, never contact the live port
7717, and never restart the owner's `ghostd.service` from a test. Deployment follows
[the maintenance runbook](../../docs/self-maintenance.md).

## Runtime notes

The `ghost` CLI edits nothing directly. It discovers the daemon token, calls
the authenticated HTTP API, and reaches the same conversation as the bar. Run `ghost help` for the current command catalog.
