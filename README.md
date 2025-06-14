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

- `mode` - is the mode that breakpoint is started with. Either _pause_ (the default)
  or _background_. When running in the background, Breakpoint won't block your workflow.
  The duration input will have no effect when running in the background.

  The default value is "pause"

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
