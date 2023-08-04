# Breakpoint

Pause, debug with SSH and resume your GitHub Actions jobs with [namespacelabs/breakpoint](https://github.com/namespacelabs/breakpoint).

## Usage

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
        uses: actions/checkout@v3

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
        uses: actions/checkout@v3

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

## Configuration
This action offers inputs that you can use to configure  `breakpoint` behavior:

* `endpoint` - is the quic endpoint of a breakpoint rendezvous server. This is
  the required parameter and by default the action will use [Namespace](https://namespace.so)
  managed server - `rendezvous.namespace.so:5000`.

* `duration` - is the initial duration of a breakpoint started by the action.
  A duration string is a possibly sequence of decimal numbers a unit suffix,
  such as "30s" or "2h5m". Valid time units are "ns", "us", "ms", "s", "m", "h".

  The default value is "30m".

* `authorized-users` - is the comma-separated list of GitHub users that would be
  allowed to SSH into a GitHub Runner. GitHub users would need to have their
  public keys configured in GitHub as `breakpoint` fetches public keys from
  GitHub and uploads them to a GitHub Runner.

* `authorized-keys` - is the comma-separated list of public SSH keys that would
  be uploaded to a GitHub Runner.

* `webhook-definition` - is the path to a webhook definition file that contains
  `url` and `payload` fields. If webhook definition is provided `breakpoint`
  will send `POST` request to the provided `url` with the provided `payload`.

  Example of such definition file for sending notifications to Slack can be
  found [here](/.github/slack-notification.json).

* `slack-announce-channel` - is a Slack channel where webhook sends and updates
  messages about started and currently active breakpoints.

  To use this feature necessary to provide `SLACK_BOT_TOKEN` environment
  variable. See [here](https://api.slack.com/authentication/token-types) how to
  create a bot token.
* `shell` - is the path to the login shell.

  The default value is "/bin/bash".

Note, that `authorized-users` and `authorized-keys` used to provided SSH access
to a GitHub Runner. The action will fail if neither `authorized-users` nor
`authorized-keys` is provided.
