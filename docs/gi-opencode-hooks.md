# OpenCode GI Hooks

The project-local `.opencode/plugins/gi-lifecycle.js` adapter connects OpenCode
1.x to `tools/invoke-gi-lifecycle-hook.ps1`. Mandatory policy remains in module
03 and `tools/get-gi-context.ps1`; this plugin does not copy policy or reimplement
Git checks, fingerprints, receipts, context limits or bounded review retries.

## Activation

Treat plugin loading and the live loop test as OpenCode runtime readiness checks.
They do not gate recording verified kit file installation from Codex or OpenCode.
Follow the [startup applicability rules](../patterns/AGENTS_RUNTIME/07-startup.md).
Report unavailable or failed activation separately; use manual Work/Complete
until hooks are verified. Zero pending migrations is not proof of active hooks.

Install the kit normally, or apply its accepted OpenCode migration. The installer
copies the plugin and shared engine, preserves unrelated plugins/configuration,
and rejects a different existing GI plugin rather than overwriting it.

Use PowerShell 7 (`pwsh`) on the OpenCode host. Set `GI_PWSH` to an absolute
PowerShell executable path if it is not on PATH. Reload OpenCode after installation;
do not use `--pure`, which disables external plugins. No global config changes,
extra npm package, API key or custom model is required by the adapter.

Verify a normal text turn: the ignored `.opencode/.gi-hook-state/events.jsonl`
must contain `rules_injected`, `completion_review_required`, another
`rules_injected`, and `completion_allowed`. Configured, loaded and verified are
different states; files on disk alone do not establish active enforcement.

## Event Mapping

| Requirement | OpenCode hook | Shared engine event |
| --- | --- | --- |
| Mandatory context on model requests | `experimental.chat.system.transform` | `UserPromptSubmit` |
| Compaction context and restored rules on the next request | `experimental.session.compacting` and system transform | `SessionStart`, `UserPromptSubmit` |
| Mandatory context in delegation, including resumed tasks | `tool.execute.before` for `task` | `PreToolUse` |
| Review before the running response loop exits | `experimental.text.complete` | `Stop` |

Task forwarding changes only `prompt`. Preserve description, agent, model and
task/session destination, exact original prompt suffix and host permission
checks. Reuse an identical generated prefix, and never forward sender preferences.

## Pre-completion Review

OpenCode 1.15.7 has no public `Stop` hook. When it finishes an assistant text
part, the adapter invokes the shared Complete check. If review is required, it
awaits `client.session.prompt` with `noReply: true` and a synthetic review message,
preserving agent/model/variant. This persists a newer user message before the
running loop evaluates its normal completion condition. The loop then continues
with the review; no idle listener, recursive generation call or text rewrite is
used. A manual Complete call does not satisfy the engine's receipt.

The synthetic review is a compact reminder with check status, without another
copy of the mandatory rules. The system transform supplies current rules on
each model request; the engine still loads full Complete context for receipts.

Only a subsequent assistant message with unchanged rules, HEAD, index and work
can complete successfully. New user turns reset continuation, changed work
requires a new review, and repeated changes/failures stop after the engine's
existing three review requests. Missing rules, SDK errors and exhausted retries
raise a visible failure with the task unverified. State is local, ignored and
host-separated; audits contain hashes/outcomes, not private text or file contents.

## Compatibility And Limits

The real response-loop test targets **OpenCode 1.15.7** and ordinary text
responses. OpenCode 2 uses a different plugin API and is not supported by this
adapter. Revalidate other versions before claiming the same guarantee.
Structured JSON responses bypass the ordinary loop exit path, so the adapter
rejects them explicitly. Compaction summaries are excluded from text review.
Streaming text can appear before the check, including intermediate text before
tools. Review prevents normal loop completion; it cannot retract streamed text.
An empty/error/cancelled response with no text-end callback has no successful
review receipt. No idle handler revives a cancelled session. Other plugins and
disabled hooks can affect enforcement; these local hooks are not tamper-proof.

The host forces context delivery and a review opportunity. It cannot prove
that a model actually reasoned correctly. Git whitespace checks do not replace
the task's required tests or integrated workflow verification.

## Verification

Run from the repository root:

```powershell
node --test tests/test_opencode_gi_hooks.mjs
node --test tests/test_opencode_gi_live.mjs
.\tools\test-gi-lifecycle-hooks.ps1
.\tools\test-instruction-kit-bootstrap.ps1
```

The live test launches the installed OpenCode with an isolated config/data/cache,
a local HTTP model fixture, denied tools and no external model requests. It
requires `INITIAL` then `REVIEWED`, actual mandatory context and the final audit
outcome `completion_allowed`, without the agent invoking Complete. Fixtures
and their runtime files are removed afterwards; user settings are not modified.

## Upstream Contract

- [OpenCode plugin loading](https://docs.opencode.ai/docs/plugins/#from-local-files):
  “Files in these directories are automatically loaded at startup.”
- [OpenCode 1.15.7 plugin interface](https://github.com/anomalyco/opencode/blob/v1.15.7/packages/plugin/src/index.ts),
  `Hooks`: `"experimental.text.complete"` receives session/message/part identity.
- [OpenCode 1.15.7 processor](https://github.com/anomalyco/opencode/blob/v1.15.7/packages/opencode/src/session/processor.ts),
  `case "text-end"`: the text hook is awaited before final part persistence.
- [OpenCode 1.15.7 prompt loop](https://github.com/anomalyco/opencode/blob/v1.15.7/packages/opencode/src/session/prompt.ts),
  `promptImpl`: `if (input.noReply === true) return message`; `runLoop` exits
  only when its latest user precedes the finished assistant (`lastUser.id < lastAssistant.id`).
