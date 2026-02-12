---
name: preview-deploy
description: Deploy a branch to a preview VM for zero-risk change review. Snapshot infra, clone it, deploy the branch on the clone, share the link. Production untouched. Use for ALL UI changes, feature demos, and PR reviews.
---

## Branch-to-Preview Deploy

Every change that has visible output should be demoed on a preview VM before merging. This is the standard review workflow.

### When to use

- Any UI change (new tabs, widgets, visual fixes)
- New API endpoints that can be exercised via the dashboard
- Any change where "see it running" is more convincing than "read the diff"
- PR descriptions — include preview links where the change is visible

### When NOT to use

- Pure backend refactors with no visible output
- Changes behind auth that can't be shared (note: magic links solve most of this)
- Trivial fixes (typos, comment changes)

### The recipe

**This is LT work. Delegate it — don't do it as the orchestrator.**

#### 1. Snapshot production infra
```
vers_vm_commit(infraVmId)
→ returns commitId
```

#### 2. Clone from snapshot
```
vers_vm_restore(commitId)
→ returns preview VM ID
```

#### 3. Deploy the branch on the clone

Task an LT with:
```
SSH to {previewVmId}.vm.vers.sh
cd /root/workspace/vers-agent-services
git fetch origin {branchName}
git checkout {branchName}
npm run build
systemctl restart agent-services
curl -s http://localhost:3000/health
```

#### 4. Generate magic link
```
POST https://{previewVmId}.vm.vers.sh:3000/auth/magic-link
Authorization: Bearer {authToken}
```

#### 5. Share with the human

Provide:
- **Preview URL**: `https://{previewVmId}.vm.vers.sh:3000`
- **Magic link** for browser auth
- **Specific page/report link** showing the change
- **Prime URL** for comparison

#### 6. Create share links for visible content

PR reviewers won't have auth tokens. Use share links for any report/page you want to show:
```
POST https://{previewVmId}.vm.vers.sh:3000/reports/{reportId}/share
Authorization: Bearer {authToken}
→ returns { url: "https://...vm.vers.sh:3000/reports/share/{linkId}" }
```

Share links require NO auth — anyone with the link can view.

#### 7. Include in PR description

When opening the PR, include the **share link** (not the auth-gated URL):
```markdown
## Demo

**Live preview (no auth required):**
https://{previewVmId}.vm.vers.sh:3000/reports/share/{linkId}

Deployed on a branch clone of infra. Production untouched.
```

#### 7. After review

- **Approved** → Deploy branch to production infra, delete preview VM
- **Rejected** → Delete preview VM. Production untouched. Zero risk.

### Key principles

- **Production is never touched until approved.** The preview VM is disposable.
- **Cheap clones.** Vers VM snapshots are instant. Don't hesitate to spin up previews.
- **Magic links solve auth.** Generate one for the reviewer.
- **Delete after review.** Preview VMs cost nothing idle but clean up anyway.
- **LTs do the ops.** Snapshot, restore, deploy, restart — all LT work.

### Environment

- Infra VM: read from registry or board context
- Auth token: same across clones (inherited from snapshot)
- Service name: `agent-services` (systemd unit)
- Build: `npm run build` (postbuild copies static files)
- Port: 3000
