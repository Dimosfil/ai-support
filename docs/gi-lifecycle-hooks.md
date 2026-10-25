# Automatic GI Lifecycle

For the OpenCode adapter to this same engine, see [OpenCode GI hooks](gi-opencode-hooks.md).

Codex executes `.codex/hooks.json`; the agent does not need to call the hook.
The shared contract owner remains module 03 and `tools/get-gi-context.ps1`.
Hooks deliver that live source instead of maintaining another copy of the rules.

- `UserPromptSubmit` injects the complete mandatory Work rules as developer
  context on each user turn.
- `SessionStart` with source `compact` restores them after context compaction.
- `PreToolUse` automatically prepends mandatory Work rules to the `prompt` of
  Codex `create_thread` and `send_message_to_thread`. Desktop service deliveries
  do not emit `UserPromptSubmit`. This hook runs in the sending chat, before the
  service call; the recipient needs no manual helper call. The rules arrive in
  the delegated service input, not a fabricated developer-role message.
- `Stop` independently builds Complete context, runs Git whitespace checks,
  and blocks the first completion attempt to require review of the entire task
  and honest gaps. Manual `-Phase Complete` cannot bypass or satisfy this hook.
  An automatic continuation with unchanged rules, HEAD, index, working changes,
  and nonignored untracked files can then finish. Changes require another review.

The visible continuation contains only a compact review reminder and check
status. Work and compaction hooks still deliver the full mandatory rules as
developer context; Stop still loads and fingerprints the full Complete context.
The reminder points to current module 03 if rules need rereading. Failed checks,
missing context and retry limits remain enforced. Codex renders Stop `reason`
as a user continuation; its documented `suppressOutput` is not implemented, so
GI cannot promise to hide that short message entirely. See the official
[common output fields and Stop protocol](https://learn.chatgpt.com/docs/hooks).

State is local and ignored under `.codex/.gi-hook-state/`. It contains hashes,
event/tool names, delivery action, counts, and check outcomes; no prompt, transcript, response, or
source diff is saved. Missing rules or a failed loader stop visibly as unverified.
Repeated failures or changes stop after three review requests with an explicit
warning, avoiding an infinite loop. No extra forms or routine approvals are added.

## Activation

Treat this section and the Codex live tests below as runtime readiness checks.
They do not gate recording verified kit file installation, including installation
from OpenCode. Follow the [startup applicability rules](../patterns/AGENTS_RUNTIME/07-startup.md).
Report unavailable or failed activation separately; zero pending migrations is
not proof of trusted hooks. Use manual Work/Complete until hooks are verified.

Use a Git project and PowerShell 7 (`pwsh`) available to the Codex hook host.
Install the kit normally; the installer preserves unrelated handlers and merges
only the canonical GI definitions. It reports **configured**, never active merely
because files were copied. A preserved, different lifecycle script requires a
scoped migration merge.

Codex must support and enable native hooks, trust the project `.codex` layer,
and trust the exact four GI definitions. Review them through `/hooks` in the
running host; changed definitions require trust again. Verify **Active** for
PreToolUse, UserPromptSubmit, SessionStart, and Stop. Open or reload the sending
chat after adding the service hook: an already-running turn can retain its old
hook configuration. There is no portable repository file that can grant
itself trusted status in every host.

Without active native hooks, the entrypoint's manual helper calls remain a
fallback; they provide no independent enforcement of invocation. Do not describe
that fallback or an untrusted installation as automatic enforcement.

## Verification

Run `tools/test-gi-lifecycle-hooks.ps1` for protocol, compaction, omitted Complete,
service delivery, unchanged task/destination, UTF-8, duplicate-prefix reuse,
unavailable-rule denial, changed files, bounded retries, and privacy.
Run `tools/test-gi-lifecycle-hooks-live.ps1 -FixturePath <empty-test-directory>`
for a real authenticated Codex CLI session in an isolated installed kit. The
first run creates an owned fixture; trust that project and its four hooks
through the native UI, then rerun. The fixture remains available for repeated
checks. It deliberately permits no tools or manual
Complete. Require the initial response, native Stop continuation, final response,
and actual audit sequence: rules injected -> review required -> completion allowed.

The live test inventories all visible hooks, rejects other sources, vets the
installed definitions, and requires normal persisted project and exact hook trust.
It does not bypass trust, modify trust state, or copy credentials. Host activation
is checked through `/hooks` and the app-server `hooks/list` API. Repeat
tests against the published source and its installed kit.

For Desktop service verification, use a freshly loaded sender with the four
trusted hooks. Create one recipient through the native tool, then send it a
second service message. The sender must pass only the original test prompts,
without manually adding rules or calling the helper. The recipient must use no
tools or manual Work/Complete. Read both actual service inputs: require the
generated prefix, the complete current module 03, unchanged task text, and
INITIAL -> native hookPrompt -> REVIEWED. Correlate both tool calls with sender
audit entries `PreToolUse/service_rules_forwarded/delivery=added` and both
recipient turns with `completion_review_required` -> `completion_allowed`.
Do not substitute a typed user message or a CLI run for either service path.

The hook uses `get-gi-context.ps1 -Phase Work -MandatoryOnly`: it forwards shared
mandatory policy without sender update status, project preferences, or local
runtime data. Preserve every destination/model/routing field and the exact
original prompt suffix. Reuse an identical generated prefix without duplication;
never strip arbitrary user text. Deny the service call explicitly if rules or
the loader are unavailable or the prefix exceeds the existing section cap.
Permission checks and authorization requirements still apply to the actual call.

All GI limits and Codex's default hook output threshold remain unchanged. The
entire output is bounded by the existing GI section cap, with no partial rule
packet on overflow. Hooks force delivery and a review opportunity; whitespace
checks do not prove product behavior. Required project tests and end-to-end
evidence still depend on the task. Stop runs after a candidate response may have
streamed, so it forces a continuation rather than retracting that text. Local
hooks are not tamper-proof and cannot guarantee model honesty or correctness.

Official behavior and trust contract: [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Правила загружаются средой Codex, финальная проверка запускается автоматически.
Пропуск `Complete` больше не пропускает проверку в доверенной среде с активными
hooks. Это не гарантия безошибочности: рабочие сценарии всё равно нужно проверять,
а недоделки и границы проверки — честно указывать.
Служебные сообщения между чатами получают общий обязательный блок автоматически
через hook отправителя; его локальные настройки получателю не передаются.
