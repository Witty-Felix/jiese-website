# AGENTS.md

Agent collaboration rules for this repo.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role triage vocabulary (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Experience Capture

After resolving a non-trivial, reusable problem, invoke the global xperience-capture Skill. The Skill must obtain user approval before creating a new project-level Skill.