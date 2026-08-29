# Keyring credentials

Ghost stores provider and MCP secrets in the desktop's Linux Secret Service,
at machine scope. The service must expose `org.freedesktop.secrets` on the user
D-Bus and its default collection must already be unlocked when `ghostd` opens a
session. The packaged daemon does not prompt, unlock, or fall back to a file.

Ghost owns the schema `io.github.ferdousbhai.ghost.Secret`. Each item has the
attributes `service` and `account`, for example `openrouter` and `personal`.
Ghost never searches for or mirrors items belonging to a standalone pi
installation, so installing both against the same desktop keyring does not join
their credential lifecycle. OAuth accounts should sign in afresh; copying a rotating refresh
token between applications creates competing refresh and revocation writers.

Portable config contains references:

```jsonc
{
  "accounts": ["openrouter/personal", "mcp.github.c0b0109d9439/personal"],
  "providers": {
    "openrouter": { "apiKey": "keyring:openrouter/personal" }
  }
}
```

```jsonc
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://example.test/mcp",
      "headers": {
        "Authorization": "keyring:mcp.github.c0b0109d9439/personal#header.QXV0aG9yaXphdGlvbg"
      }
    }
  }
}
```

`keyring:<service>/<account>` selects the item's `value` field; `#<field>`
selects another named field in the same item. `models.json.accounts` is policy,
not discovery: a ghost cannot resolve an item absent from that list even when
another ghost uses it. Rename and delete never touch the item. Restoring a
trashed home restores only its references and policy, which can use the same
machine account again.

Logging out removes the selected whole service/account item, not one ghost's
permission line. Other accounts remain valid; every ghost that references the
logged-out machine account fails closed until that account signs in again.

On the first open after upgrade, Ghost imports legacy plaintext `.pi/auth.json`
and, where an older home still has one, the OMP-era `.pi/agent.db` credential
rows, and replaces provider and MCP literals. Each keyring
write is read back before portable config changes or plaintext removal. Config
replacements are atomic and durable; `agent.db` is emptied down to its schema
and change-counter rows and vacuumed, and `auth.json` is removed. The scrub
takes every other table, not just the credential ones: the usage, client, and
cache rows there name the account and the machine too, in a file that gets
backed up and copied like any other. A credential that runtime had disabled is not
migrated and is deleted with the rest — the keyring store has no disabled state
to carry it into, and a dead secret there would claim the account name a working
login wants — so log in again to replace it. Matching literals reuse an existing
Ghost schema item; a conflicting value receives `account-2`, `account-3`, and so
on rather than overwriting another login, even if the secret-free metadata
database was lost. An interrupted run resumes from the source that remains. A
locked or missing service, absent item, disallowed account, malformed item, or
failed verification is reported as a keyring error and leaves plaintext
migration sources available for retry.

Nothing recreates `.pi/agent.db` afterwards, so a home created after the move
never has one. An `mcp.json` server that Ghost's MCP schema rejects is a
different kind of problem and gets a different answer: migration leaves that row
byte-for-byte alone, `GET …/mcp` keeps listing it as skipped with its field-only
reason, and a mutation on it keeps failing with `invalid_mcp_server`. A secret
in such a row stays in plaintext because the row cannot be parsed safely, so fix
the row — the next session open migrates it and the credential is worth rotating
in the meantime.

Migration cannot retract credentials from copies made earlier. Old backups,
sync history, filesystem snapshots, and Trash may still contain `models.json`,
`mcp.json`, `agent.db`, or `auth.json` plaintext. Remove those copies where
appropriate and rotate the credential at its provider whenever their exposure
cannot be ruled out.

Secret Service keeps values off portable disk and encrypts them at rest. It is
not a security boundary against another process already running as the same OS
owner while the collection is unlocked.

A login keyring with a blank password auto-unlocks on first access, so it can
never be observed locked and Ghost's locked-keyring error will not occur on such
a machine. That is the normal arrangement under display-manager autologin, where
PAM has no password to unlock a keyring with; at-rest protection then comes from
full-disk encryption alone. Fail-closed still holds where it matters — a
passworded keyring that is locked, or an absent Secret Service, is an error,
never a plaintext fallback.
