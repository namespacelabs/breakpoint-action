# Breakpoint

Pause, debug with SSH and resume your GitHub Actions jobs with [namespacelabs/breakpoint](https://github.com/namespacelabs/breakpoint).

## Usage

### Pause on failure

The following example shows how to define a step in a GitHub Actions job to run
`breakpoint` in case of job's failure (so it won't pause successful runs):

```yaml
jobs:
  tests:
    runs-on: ubuntu-latest

    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout the repository
        uses: actions/checkout@v4

      - name: Run tests
        shell: bash
        run: ...

      - name: Breakpoint if tests failed
        if: failure()
        uses: namespacelabs/breakpoint-action@v0
        with:
          duration: 30m
          authorized-users: jack123, alice321
```

### Pause at any step

Or it can pause workflow jobs at any step:

```yaml
jobs:
  tests:
    runs-on: ubuntu-latest

    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout the repository
        uses: actions/checkout@v4

      - name: Build images
        shell: bash
        run: docker build .

      - name: Breakpoint to check the build results
        uses: namespacelabs/breakpoint-action@v0
        with:
          duration: 30m
          authorized-users: jack123, alice321

      - name: Run tests
        shell: bash
        run: ...
```

When Breakpoint activates, it will output on a regular basis how much time left there is in the breakpoint, and which address to SSH to get to the workflow.

```bash
┌───────────────────────────────────────────────────────────────────────────┐
│                                                                           │
│ Breakpoint running until 2023-05-24T16:06:48+02:00 (29 minutes from now). │
│                                                                           │
│ Connect with: ssh -p 40812 runner@rendezvous.namespace.so                 │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Pause with idle-aware timeout

`mode: pause-idle` pauses the workflow until either (a) no SSH session has
connected within `grace-period`, or (b) a session connected and then all
sessions have been disconnected for longer than `idle-timeout`. This is useful
when you want "long enough for a human to attach if they're around, no longer
than necessary if they're not".

```yaml
- name: Pause with idle-aware timeout
  if: failure()
  uses: namespacelabs/breakpoint-action@v0
  with:
    mode: pause-idle
    grace-period: 5m
    idle-timeout: 20m
    authorized-users: jack123, alice321
```

### Discovering the SSH endpoint outside the runner

The action emits the SSH connection string (`Connect with: ssh -p ... runner@...`)
to the step log, but GitHub buffers step logs until the step completes — which
for `pause`-style modes means the endpoint is invisible until the breakpoint
ends. To make the endpoint observable while the step is still active, the
action also:

- Sets a step output `endpoint`, e.g. `${{ steps.bp.outputs.endpoint }}`.
- Emits a Check Run annotation via `::notice::`, visible in the run summary
  and queryable through the REST API while the run is in progress.
- Optionally posts a pull-request comment with the endpoint (and removes it on
  exit). Useful for external CI watchers / AI assistants that follow PR events.

```yaml
- name: Pause on failure with PR notification
  if: failure() && github.event_name == 'pull_request'
  id: bp
  uses: namespacelabs/breakpoint-action@v0
  with:
    mode: pause-idle
    authorized-users: jack123, alice321
    comment-on-pr: true
    github-token: ${{ github.token }}
    comment-marker: BREAKPOINT_OPEN
    comment-extra-hint: |
      Run inside the SSH session:
      `docker exec -ti $(docker ps --filter name=my-sandbox -q | head -1) bash`
```

The PR comment uses the configurable `comment-marker` as an HTML comment on
the first line, so other tooling can grep for it.

### Run in the background

Breakpoint can also be started in the background to allow connecting at any point during the workflow.
This allows inspecting long-running steps or debugging stuckness.

Breakpoint will keep your workflow running after completion while there are active SSH connections.

```yaml
jobs:
  tests:
    runs-on: ubuntu-latest

    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout the repository
        uses: actions/checkout@v4

      - name: Start Breakpoint in the background
        uses: namespacelabs/breakpoint-action@v0
        with:
          mode: background
          authorized-users: jack123, alice321

      - name: Run tests
        shell: bash
        run: ...
```

> [!NOTE]
> Breakpoint takes on the environment of the step it's launched in.
> Modifications to environment variables in later steps won't be reflected in the SSH session.

## Configuration

This action offers inputs that you can use to configure `breakpoint` behavior:

- `duration` - is the initial duration of a breakpoint started by the action.
  A duration string is a possibly sequence of decimal numbers a unit suffix,
  such as "30s" or "2h5m". Valid time units are "ns", "us", "ms", "s", "m", "h".

  The default value is "30m".

- `mode` - is the mode that breakpoint is started with. Either _pause_ (the default),
  _background_ or _pause-idle_. _pause_ blocks until duration is reached or the user
  resumes. _background_ won't block your workflow (and the duration input is ignored).
  _pause-idle_ blocks while there are active SSH connections, with a `grace-period`
  for the first connection and an `idle-timeout` after the last one.

  The default value is "pause"

- `grace-period` - (pause-idle only) how long to wait for the first SSH connection
  before giving up. Accepts Go duration syntax (e.g. `5m`, `30s`).

  The default value is "5m".

- `idle-timeout` - (pause-idle only) how long with zero active SSH connections
  before the breakpoint exits, after at least one session has connected.

  The default value is "20m".

- `comment-on-pr` - if `true`, post a pull-request comment when the SSH endpoint
  is detected, and delete it on exit. Requires `github-token` with
  `pull-requests: write` and a `pull_request` event context.

  The default value is "false".

- `github-token` - token used to post and delete the PR comment. Typically
  `${{ github.token }}` or a PAT with `pull-requests:write`.

- `comment-marker` - opaque HTML-comment marker placed on the first line of the
  PR comment. Other tooling (CI watchers, AI assistants) can search the PR
  comment list for this marker.

  The default value is "BREAKPOINT_OPEN".

- `comment-extra-hint` - optional extra Markdown appended to the PR comment
  body. Useful for project-specific hints (e.g. how to enter a debug sandbox).

- `authorized-users` - is the comma-separated list of GitHub users that would be
  allowed to SSH into a GitHub Runner. GitHub users would need to have their
  public keys configured in GitHub as `breakpoint` fetches public keys from
  GitHub and uploads them to a GitHub Runner.

- `authorized-keys` - is the comma-separated list of public SSH keys that would
  be uploaded to a GitHub Runner.

- `webhook-definition` - is the path to a webhook definition file that contains
  `url` and `payload` fields. If webhook definition is provided `breakpoint`
  will send `POST` request to the provided `url` with the provided `payload`.

  Example of such definition file for sending notifications to Slack can be
  found [here](/.github/slack-notification.json).

- `slack-announce-channel` - is a Slack channel where webhook sends and updates
  messages about started and currently active breakpoints.

  To use this feature necessary to provide `SLACK_BOT_TOKEN` environment
  variable. See [here](https://api.slack.com/authentication/token-types) how to
  create a bot token.

- `shell` - is the path to the login shell.

  The default value is "/bin/bash".

- `endpoint` - is the quic endpoint of a breakpoint rendezvous server.
  By default the action will use a [Namespace](https://namespace.so)
  managed server - `rendezvous.namespace.so:5000`.
  Use this option when you want to use a different server or [host your own](https://github.com/namespacelabs/breakpoint/blob/main/docs/server-setup.md)

Note, that `authorized-users` and `authorized-keys` used to provided SSH access
to a GitHub Runner. The action will fail if neither `authorized-users` nor
`authorized-keys` is provided.

## Outputs

- `endpoint` - the SSH endpoint string emitted by breakpoint
  (e.g. `ssh -p 40812 runner@rendezvous.namespace.so`), or empty if it was
  not detected before the step finished.
