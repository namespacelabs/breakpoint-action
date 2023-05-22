# breakpoint-action

Pause, debug and resume your GitHub Actions jobs with [namespacelabs/breakpoint](https://github.com/namespacelabs/breakpoint).

# Configuration
This action offers inputs that you can use to configure  `breakpoint` behavior:

* `endpoint` - is the quic endpoint of a breakpoint rendezvous server. This is
  the required parameter and by default the action will use [Namespace](https://namespace.so)
  managed server - `breakpoint.namespace.so:5000`.

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

Note, that `authorized-users` and `authorized-keys` used to provided SSH access
to a GitHub Runner. The action will fail if neither `authorized-users` nor
`authorized-keys` is provided.

# Usage

These examples show how you can define a step in a workflow job. The action can
pause workflow jobs at any step:

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

Or it can be use to pause workflow jobs only on failures (so it won't pause
successful runs):

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
