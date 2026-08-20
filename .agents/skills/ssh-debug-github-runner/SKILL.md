# SSH Debug GitHub Runner

SSH into a running GitHub Actions runner for live debugging.

## Trigger

User says: "ssh into runner", "debug runner", "login to runner", "ssh debug"

## Prerequisites

- tmate must be in the workflow (already in `e2e.yml` via `workflow_dispatch` input)
- `gh` CLI authenticated

## Steps

### 1. Trigger E2E workflow with debug input

```bash
gh workflow run e2e.yml -f debug=true
```

### 2. Wait for tmate to start

```bash
# Watch for the tmate step to complete
gh run list --workflow=e2e.yml --limit=1 --json databaseId,status
gh run watch <run-id> --exit-status
```

Or check the run logs for the tmate SSH command:

```bash
gh run view <run-id> --log | grep -A2 "Setup SSH debug"
```

### 3. Get the SSH command from logs

```bash
RUN_ID=$(gh run list --workflow=e2e.yml --limit=1 --json databaseId --jq '.[0].databaseId')
ssh_cmd=$(gh run view $RUN_ID --log 2>/dev/null | grep -oP 'ssh \S+@\S+\.tmate\.io' | head -1)
echo "$ssh_cmd"
```

### 4. Connect

```bash
$ssh_cmd
# Example: ssh aBcDeFg@lon1.tmate.io
```

You're now inside the runner with full shell access.

### 5. Cleanup

When done, the tmate session auto-closes after timeout (default 30 min) or when the workflow completes.

## Quick One-liner

```bash
RUN_ID=$(gh run list --workflow=e2e.yml --limit=1 --json databaseId --jq '.[0].databaseId') && gh run view $RUN_ID --log 2>/dev/null | grep -oP 'ssh \S+@\S+\.tmate\.io' | head -1 | xargs -I {} bash -c 'echo "Run: {}" && {}'
```
