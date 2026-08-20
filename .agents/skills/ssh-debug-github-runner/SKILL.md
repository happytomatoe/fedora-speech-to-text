---
name: ssh-debug-github-runner
description: SSH into a running GitHub Actions runner for live debugging via tmate. Triggers on 'ssh into runner', 'debug runner', 'login to runner', 'ssh debug'.
---

# SSH Debug GitHub Runner

Reference: <https://github.com/marketplace/actions/debugging-with-tmate>

## Prerequisites

- `gh` CLI authenticated
- `herdr` available (for Herdr writesplit)
- Workflow `.github/workflows/ssh-debug.yml` with:
  - `on: pull_request` trigger
  - `mxschmitt/action-tmate@v3` with `detached: true`
  - `mshick/add-pr-comment@v3` to post SSH command
  - `sleep 600` to keep session alive

## Steps

### 1. Push to trigger workflow

```bash
git commit --allow-empty -m "trigger ssh debug" && git push
```

### 2. Wait for PR comment with SSH command

```bash
# Get PR number for current branch
PR_NUMBER=$(gh pr list --head $(git branch --show-current) --json number --jq '.[0].number')

# Wait for comment (polls every 5s, timeout 90s)
wait_until 90 5 "SSH comment" bash -c \
  "gh api repos/{owner}/{repo}/issues/$PR_NUMBER/comments --jq '.[] | select(.body | contains(\"SSH Debug Session\")) | .body'"
```

### 3. Extract SSH command

```bash
SSH_CMD=$(gh api repos/{owner}/{repo}/issues/$PR_NUMBER/comments \
  --jq '.[] | select(.body | contains("SSH Debug Session")) | .body' \
  | grep -oP 'ssh \K[^\s]+')
```

### 4. Herdr right split pane + SSH

```bash
# Create split pane
PANE_ID=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus | jq -r '.result.pane.pane_id')

# Run SSH command
herdr pane run $PANE_ID "ssh $SSH_CMD"

# Accept host key (first time)
wait_until 10 2 "host key prompt" herdr pane read $PANE_ID --source visible --lines 20
herdr pane send-text $PANE_ID "yes"
herdr pane send-keys $PANE_ID enter

# If tmux status bar appears, press q
herdr pane send-text $PANE_ID "q"
herdr pane send-keys $PANE_ID enter
```

### 5. Run commands in the runner

```bash
herdr pane send-text $PANE_ID "whoami && hostname && pwd"
herdr pane send-keys $PANE_ID enter
herdr pane read $PANE_ID --source visible --lines 20
```

## How It Works

1. Workflow triggers on `pull_request`
2. tmate starts in detached mode (session ID printed, workflow continues)
3. `add-pr-comment` posts SSH command to PR
4. Workflow sleeps 600s to keep tmate alive
5. You SSH in via Herdr writesplit pane

## Troubleshooting

- **"Connection closed"**: tmate session expired or workflow ended
- **No PR comment**: Check `pull-requests: write` permission in workflow
- **Host key prompt**: Type `yes` + enter (first connection only)
- **tmux status bar**: Press `q` to dismiss
