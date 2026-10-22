# External events

Ghost accepts selected external events through `ghost event` or the owner-only
`POST /api/ghosts/:ghost/events` route. Existing CLIs and services own provider
authentication, subscriptions, filtering, and catch-up. Ghost adds no public
webhook, provider tokens, or polling daemon.

```sh
printf '%s' '{"issue":42,"title":"Review requested"}' |
  ghost event github:owner/repo issue-42-update-1 -g casper \
    --instructions 'Summarize this update and identify what needs my attention.' -
```

The response names a normal conversation. Open it in the HUD or phone history,
or use `ghost show -g casper -s event-…`. Each source/id maps to one conversation;
concurrent delivery, provider retries, and daemon restart do not start another
turn. Use an identity that includes the provider account/repository and a stable
update/event id. A changed payload or owner instruction under an existing id is
refused. Each distinct event has its own conversation, so another busy
conversation does not delay it. A repeated busy event is acknowledged without
queuing additional work.

The owner supplies instructions separately from the untrusted event payload.
The payload is data, including any instructions embedded in third-party text;
it cannot become a shell `!command`. A bridge must use fixed owner instructions,
not copy that field from incoming third-party data. Guests cannot submit events.

Acceptance is logged before the caller is acknowledged. Delivery returns before
the harness finishes; inspect the conversation for the reply or failure. After
a crash, an accepted event may have an unanswered prompt: Ghost does not replay
it automatically. Inspect and explicitly continue that conversation if needed.
A failed turn is also not automatically retried by repeated delivery. Deleting
its conversation removes the deduplication evidence and permits later replay.

## GitHub with the installed CLI

`ghost help events -g casper` prints the complete Bash polling recipe. It uses
`gh api --paginate --slurp` to fetch an overlapping window of notifications,
filters one selected repository with `jq`, and delivers each notification/update
id with `ghost event`. Test the script manually before scheduling it as a
systemd oneshot and timer (`ghost help timers`). The service's journal contains
acceptance receipts; the Routines log view links those event conversations.

`gh` owns sign-in. GitHub's notifications API requires a classic token with
`notifications` or `repo` scope; Ghost never reads or stores it. Honor GitHub's
poll interval and rate limits. See the official [GitHub CLI API guide](https://cli.github.com/manual/gh_api)
and [notifications documentation](https://docs.github.com/en/rest/activity/notifications).

The recipe catches up seven days by default and deduplicates overlapping polls.
Fetch or delivery failures fail the systemd service, leaving the cause in its
journal; the next scheduled run retries unaccepted events in that window.
Increase the window deliberately after longer downtime, within provider
retention. Notifications coalesce thread updates and do not guarantee a
separate delivery of every comment. Pause/resume, edit, run now, logs, removal,
and recovery use the ordinary Routines controls. Execution requires this
machine and the owner's session to be running and connected.

## Slack with an existing bridge

An authenticated Slack Events API or Socket Mode bridge can forward the
selected event's `event_id` as the id and its event JSON on stdin. Choose a
source including the workspace identity. The bridge owns the Slack app,
OAuth scopes, verification, acknowledgement, retry policy, and filters. Ghost
uses none of those credentials. See Slack's official [Events API guide](https://docs.slack.dev/apis/events-api/).

Use the bridge's authenticated local command execution to call `ghost event`;
keep the daemon loopback-only. Do not point Slack at ghostd or expose its
machine-local token publicly. Slack's transport and retention determine replay
and catch-up; reconnecting alone is not a promise that missed events return.
Disconnect the bridge or pause/remove its native systemd routine to stop intake.
Ghost bundles no Slack app or bridge and creates no external subscription during
installation.
