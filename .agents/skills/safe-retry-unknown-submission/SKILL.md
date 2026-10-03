---
name: safe-retry-unknown-submission
description: Guide idempotent retry design for multi-step upload or registration flows when the final response is lost and the outcome is unknown. Use for this project's H5 or WeChat mini-program submission paths, not ordinary transport retries.
---

# Safe retry for an unknown submission result

Use this skill when a flow can store media or other side effects before the final registration response is received. The goal is to let a member recover from a missing response without turning one intended submission into two.

## Core model

- Treat the submission identity as the identity of one attempt. In this project that identity is the `submission_id` issued by `prepare`.
- Keep two product actions separate: **retry this submission** and **create another check-in today**. They use different wording and different intent even when both ultimately call `finalize`.
- A missing `finalize` response is an **unknown** result, not a known failure. Preserve the original submission identity and any upload receipts needed to retry it.
- `already` means that the original attempt had already completed; the retry must have zero new registration side effects. `new` means this request created the registration.

## Required interaction shape

1. Show an actionable unknown state. Make manual **重交本次登记** the primary action when the server can safely deduplicate the original identity.
2. Require an explicit user action before retrying. Do not start an automatic retry from the unknown state.
3. Reuse the original `submission_id`; do not call `prepare` again for a retry of the same attempt. A new `prepare` creates a new identity and defeats idempotency.
4. Render the outcomes separately:
   - `already`: “此前已登记，本次未新增。”
   - `new`: “本次新登记。”
   - explicit retry failure: keep the same submission retryable and allow another deliberate retry when the backend contract permits it.
5. Keep **去打卡榜核对** as an optional secondary path when useful, but explain the list's consistency delay. In this project, a missing row can persist for about 60 seconds; absence from the list is not proof that registration failed. Returning from the check must not discard the original retry identity.

## Duplicate-day confirmation

Use one conceptual confirmation with the same calm wording at both server touchpoints:

> 今天已有一条打卡。按你的选择，今天也可以再登记一条。

- If `prepare` reports `already_today`, ask before the expensive upload and carry the user's decision through to `finalize`.
- If `finalize` later returns `409 duplicate_day` because the state changed during upload, ask at that point instead.
- Do not ask twice when the earlier confirmation is still authoritative; ask again only when the later response represents a new state observation.
- Never describe a same-day second registration as a retry of the original submission. The member must be able to tell “同一次重交” from “今天再登记一条”.

## Verification checklist

Before declaring a change safe, verify the current backend contract and exercise these cases:

- the same `submission_id` finalized twice: one `new`, then one `already`, with no duplicate side effects;
- unknown result → manual retry → `already`, `new`, and explicit failure;
- explicit failure → another deliberate retry, if partial-write and soft-lock behavior make that safe;
- `already_today` at `prepare` and `duplicate_day` at `finalize`, including the no-double-prompt path;
- the ranking-list delay is visible in the copy and does not destroy the pending retry state;
- the retry path never creates a fresh submission identity.

If the backend's partial-write behavior or idempotency boundary differs from these assumptions, stop and inspect the current implementation and ADR before promising that retry is safe.

## Project references

Read current source rather than copying this guide as an implementation spec:

- `docs/adr/0010-finalize-idempotency.md`
- `functions/api/_submission.js`
- `functions/api/prepare.js`
- `functions/api/finalize.js`
- `app.js`
- `docs/prototypes/wechat-miniprogram-upload.html`
