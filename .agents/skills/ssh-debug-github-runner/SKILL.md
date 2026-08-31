---
name: ssh-debug-github-runner
description: SSH into a running GitHub Actions runner for live debugging via upterm. Triggers on 'ssh into runner', 'debug runner', 'login to runner', 'ssh debug'.
---

# SSH Debug GitHub Runner

Reference: <https://github.com/owenthereal/action-upterm>

## Prerequisites

- `gh` CLI authenticated
- `herdr` available (for Herdr writesplit)
- SSH key added to GitHub account (for upterm authentication)
- Workflow `.github/workflows/e2e.yml` with:
  - `owenthereal/action-upterm@v1` with `detached: true` and `limit-access-to-actor: true`
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
2. upterm starts in detached mode (session created, workflow continues)
3. `add-pr-comment` posts SSH command to PR (on PR events only)
4. E2E tests run while upterm session is active (45 min timeout)
5. You SSH in via Herdr writesplit pane to troubleshoot
## Troubleshooting

- **"Connection closed"**: upterm session expired or workflow ended
- **No PR comment**: Check `pull-requests: write` permission in workflow
- **Host key prompt**: Type `yes` + enter (first connection only)
- **Passphrase prompt**: Enter your SSH key passphrase, or run `ssh-add ~/.ssh/id_ed25519` to cache it
- **tmux status bar**: Press `q` to dismiss — DO NOT read screen before dismissing, prompt is hidden behind it
- **Can't see prompt**: Always dismiss tmux bar first, then read. The bar obscures the shell prompt.
- **Permission denied (publickey)**: Ensure your SSH key is added to GitHub and `limit-access-to-actor: true` is set in workflow