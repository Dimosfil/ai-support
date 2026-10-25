# Agent Instructions

Load only task-relevant modules under `patterns/AGENTS_RUNTIME/`. Prefer more
specific project-local instructions, contracts, memory, and runbooks.

## Project

`ai-support` — переносимая основа поддержки пользователей и очереди операторов.
Сначала сайт, затем Telegram с общей историей обращений. Реализована локальная
основа G0/G1 и механизм G2.2: Node.js 24, SQLite, встраиваемое ядро,
HTTP/web-адаптер и optional delivery worker. Новая схема v2; v1 без автоматической
миграции. Доставка и входные адаптеры: `docs/NOTIFICATIONS.md`.
Продуктовый контекст: `SUPPORT_SYSTEM_PLAN.md`; контракт: `docs/CORE_CONTRACT.md`.
Production-хостинг и интеграция реального продукта пока не выбраны.

## Goal And Loading Contract

- For Unity projects, also load `20-unity-projects.md` before Unity work.
- Derive a bounded goal and observable success criteria from the request and
  project context. Ask only when missing information materially changes scope;
  continue independent authorized work while waiting.
- This file alone is sufficient only for greetings and status-neutral replies.
  Before concrete work, select the matching runtime modules.
- For a GI command, run
  `tools/get-gi-context.ps1 -CommandText "<exact user command>"`. It performs the
  staged update check, longest-prefix route resolution, and bounded retrieval.
  Use `COMMANDS.md` directly only for help or command-index requests.
- On the first concrete task, perform the staged update check. Equal versions
  without skipped migrations mean `pending migrations: 0` without reading
  migrations, `CHANGELOG.md`, or `INDEX.md`. Apply pending accepted migrations
  automatically; absent `auto_apply_pending_migrations` defaults to `true`.
  Skip only for explicit `false` with metadata path/key/value evidence, or a
  concrete blocker; report the pending count. Helper limitations are not opt-outs.
  Never inspect `updates/` during this startup check.
- Treat “do/follow strictly by GI” and equivalents as strict compliance with all
  loaded rules. Report a blocked operation precisely and continue independent
  authorized work.
- Before adding a clarification or approval gate, apply
  `patterns/AGENTS_RUNTIME/03-rule-precedence.md` and existing authorization.
- Before work, load module 03; before completion, load module 15.
- Final: load `patterns/AGENTS_RUNTIME/15-final-review.md`.
- Record verified instruction installation separately from host activation;
  follow `patterns/AGENTS_RUNTIME/07-startup.md`. Missing host trust/live tests
  remain explicit runtime gaps.
<!--gi-->
- Verify the full task, report gaps, and agree material complexity first.
- Active GI hooks in Codex or OpenCode load rules and require final review automatically.
  Otherwise run `tools/get-gi-context.ps1` before work and `-Phase Complete`
  before final. Apply its rules; load failure blocks completion.
<!--/gi-->
- State-changing GI commands must not run from memory. If the context builder,
  route manifest, resolver, or a mandatory routed file is missing, stop that
  operation and name the missing path.
- Broad or unclear work requires `01-purpose.md`, `03-rule-precedence.md`,
  `06-tool-usage-and-token-economy.md`, and the most relevant task module.
  Cross-topic work requires every matching module.

## Core Safety And Boundaries

- Before implementation, bug fixes, or refactoring, load modules 04, 06, and 15.
  Trace the affected scenario, identify its mechanism and contract owner, and
  correct the cause there. Justify any bypass. Follow the mechanism gate in
  `patterns/ARCHITECTURE_AND_CODE_QUALITY.md`; align code, tests, docs, and memory.
- Verify the active project root and target identity before writes. Treat this
  root as the normal filesystem boundary; exact external paths and actions need
  explicit authorization. Preserve unrelated dirty changes.
- A pasted credential is not a blocker for unrelated work. Warn once without
  repeating it, recommend rotation, and block only operations that cannot use it
  safely.
- Warn before third-party service launches; load runtime module 09.
- Never commit secrets, private data, model weights, checkpoints, photos, video,
  audio, datasets, archives, or similar large content payloads. Use approved
  artifact storage and commit compact manifests, checksums, sources, or
  retrieval instructions unless the exact exception is explicitly approved.
- Keep rebuildable build output in dedicated ignored directories and out of
  source Git; version build inputs. Follow
  `patterns/AGENTS_RUNTIME/09-build-and-install.md` for authorized cleanup,
  verification, and explicitly approved project exceptions.
- `tools/` is for durable reusable development and agent tooling. Product code,
  tests, docs, outputs, screenshots, exports, downloaded data, build bundles,
  and one-off probes belong in documented project locations.
  `tools/project-memory/` holds compact implementation-driving knowledge and
  evidence references, not bulk artifacts or a replacement for source/tests.
- During meaningful behavior or architecture work, keep scoped code, tests,
  affected docs, and focused project-memory contracts aligned before the
  implementation task is complete.
- For large modular systems, keep a project-local system map, focused module
  passports, and explicit public contracts. Agree on ownership and integration
  edges before independent agents implement both sides; verify assembled
  workflows. Follow `patterns/MODULAR_SERVICE_ENGINEERING.md`.
- Do not revert user changes without an explicit request. Ask before destructive
  operations, broad formatting churn, dependency replacement, data migration,
  public contract changes, or unrelated expansion.

## Runtime Routing

- Purpose, RAG, memory, summaries, connected projects: `01-purpose.md`
- Repository map: `02-repository-map.md`; precedence/scope: `03-rule-precedence.md`
- Authoring, configuration, quality, inventories: `04-content-and-authoring.md`
- Windows shell/networking: `05-windows-command-policy.md`
- Token economy and info/stack/logic/refactor: `06-tool-usage-and-token-economy.md`
- Startup/restore: `07-startup.md`; scope/evidence/cleanup: `07-scope-and-evidence.md`
- Config: `08-config-service.md`; task manager: `08-task-manager.md`; sprints: `08-sprint.md`
- Publication: `09-production.md`; deploy: `09-deploy-gateway.md`; FTP: `09-ftp.md`
- Runtime/restart/defaults: `09-runtime-and-defaults.md`; tester: `09-testing.md`
- Full-system verification: `09-full-testing.md`
- Build/install: `09-build-and-install.md`; memory operations: `09-project-memory-operations.md`
- Private/missing context: `10-private-scope-and-missing-context.md`
- Language: `11-language-preferences.md`; UI: `12-ui-and-focus.md`; progress: `13-progress-updates.md`
- Updates: `14-update-intake.md`; verification: `15-verification.md`; Git: `16-git-policy.md`
- Roles: `17-agent-role-office.md`; product engineering: `18-startup-product-engineering.md`
- Game modding: `19-game-modding.md`

All paths above are under `patterns/AGENTS_RUNTIME/`. The legacy combined 07/08/09
files are compatibility indexes only and contain no operational rules.

## Project Memory And Working Areas

- Исходный код: `src/`; тесты: `tests/`; product scripts: `scripts/`.
  Локальные credentials/config: `.local/`; БД: `data/`; оба каталога ignored.
  Компиляции/сборки пока нет. Текущий план: `SUPPORT_SYSTEM_PLAN.md`.
- Summaries: `tools/summary/`; durable project knowledge:
  `tools/project-memory/`; reusable tooling: `tools/`.
- Put product behavior, business rules, workflow contracts, architecture
  decisions, and verified implementation findings in project memory. Put normal
  documentation in `README.md`, `docs/`, and runbooks.
- Preserve text encodings. On Windows, send non-ASCII API/admin write bodies as
  explicit UTF-8 bytes with `charset=utf-8` or via Node `fetch`, then read back
  and check for replacement characters or mojibake.

## Local Commands

Команды GI и текущие ограничения описаны в `tools/AGENT_RUNBOOK.md`.
Запуск и проверки: `docs/LOCAL_RUN.md`, скрипты в `package.json`.
UI визуально проверяет пользователь, если отдельно не запрошена проверка агентом.

## Windows Command Policy

- Prefer PowerShell-native networking: `Invoke-RestMethod` for HTTP API calls
  and `Invoke-WebRequest` for downloads instead of `curl.exe`.
- Do not probe for curl unless the user explicitly requests curl diagnostics.
- Prefer bundled/user tools from `D:\.codex\bin` before WindowsApps or System32 shims.
