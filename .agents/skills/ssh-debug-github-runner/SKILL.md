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

E2E (workflow_dispatch — only works from default branch):
```bash
gh workflow run "E2E Tests" -f debug=true
```

SSH Debug (pull_request — triggers on push):
```bash
git commit --allow-empty -m "trigger ssh debug" && git push
```

### 2. Wait for comment

```bash
watch -n 5 'gh api repos/happytomatoe/fedora-speech-to-text/issues/109/comments --jq '"'"'.[-1].body'"'"''
```

### 3. Copy SSH command from comment

Look for line like: `ssh xyzabc123@lon1.tmate.io`

### 4. Connect (no flags, run as-is)

```bash
ssh xyzabc123@lon1.tmate.io
```

### 5. Cleanup

tmate session auto-closes after timeout or workflow completion.
