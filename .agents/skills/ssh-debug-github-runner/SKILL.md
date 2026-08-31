---
name: ssh-debug-github-runner
description: SSH into a running GitHub Actions runner for live debugging via tmate. Triggers on 'ssh into runner', 'debug runner', 'login to runner', 'ssh debug'.
---

# SSH Debug GitHub Runner

Reference: <https://github.com/marketplace/actions/debugging-with-tmate>

## Prerequisites

- `gh` CLI authenticated
- `herdr` available (for Herdr writesplit)
- Workflow `.github/workflows/e2e.yml` with:
  - `mxschmitt/action-tmate@v3` with `detached: true`
  - `mshick/add-pr-comment@v3` to post SSH command

## Quick Start
### 1. Trigger the workflow

```bash
git commit --allow-empty -m "trigger ssh debug" && git push
```

### 2. Connect

The script waits for the PR comment, then SSHes in via Herdr:

```bash
.agents/skills/ssh-debug-github-runner/scripts/ssh-connect.sh [PR_NUMBER] [GITHUB_WORKFLOW_RUN_ID]
```

If no PR number, auto-detects from current branch. If no run ID, uses latest SSH comment.

### 3. Run commands in the runner

```bash
herdr pane send-text $PANE_ID "whoami && hostname && pwd"
herdr pane send-keys $PANE_ID enter
herdr pane read $PANE_ID --source visible --lines 20
```
## How It Works

1. E2E workflow triggers on `pull_request` or `push`
2. tmate starts in detached mode (session ID printed, workflow continues)
3. `add-pr-comment` posts SSH command to PR (on PR events only)
4. E2E tests run while tmate session is active
5. You SSH in via Herdr writesplit pane to troubleshoot
## Troubleshooting

- **"Connection closed"**: tmate session expired or workflow ended
- **No PR comment**: Check `pull-requests: write` permission in workflow
- **Host key prompt**: Type `yes` + enter (first connection only)
- **tmux status bar**: Press `q` to dismiss — DO NOT read screen before dismissing, prompt is hidden behind it
- **Can't see prompt**: Always dismiss tmux bar first, then read. The bar obscures the shell prompt.