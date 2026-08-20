---
name: ssh-debug-github-runner
description: SSH into a running GitHub Actions runner for live debugging
triggers:
  - ssh into runner
  - debug runner
  - login to runner
  - ssh debug
prerequisites:
  - tmate must be in the workflow
  - `gh` CLI authenticated
  - GitHub-registered SSH key must be in ssh-agent
---

# SSH Debug GitHub Runner

## Steps

### 1. Trigger workflow

```bash
git commit --allow-empty -m "trigger ssh debug" && git push
```

### 2. Get run ID and wait for comment

```bash
# Get the latest run ID
RUN_ID=$(gh run list --workflow=ssh-debug.yml --limit=1 --json databaseId --jq '.[0].databaseId')
echo "Run: $RUN_ID"

# Wait for comment with this run ID
watch -n 5 'gh api repos/happytomatoe/fedora-speech-to-text/issues/109/comments --jq '"'"'.[] | select(.body | contains("Run: '$RUN_ID'")) | .body'"'"''
```

### 3. Copy SSH command from comment

Look for line like: `ssh xyzabc123@lon1.tmate.io`

### 4. Connect (no flags, run as-is)

```bash
ssh xyzabc123@lon1.tmate.io
```

### 5. Cleanup

tmate session auto-closes after timeout or workflow completion.
