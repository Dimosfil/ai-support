# Agent Runbook

## Текущее состояние

На 23.10.2026 реализована локальная основа G0/G1 на Node.js/SQLite.
Продуктовый контекст: `SUPPORT_SYSTEM_PLAN.md`; краткое описание: `README.md`.
Запуск, конфигурация, local credentials, проверки и ограничения:
`docs/LOCAL_RUN.md`. Контракт: `docs/CORE_CONTRACT.md`; HTTP: `docs/API.md`.
Исходники: `src/`; тесты: `tests/`. Компиляция и упаковка пока не требуются.
Сервер пишет только сообщения запуска и обезличенные ошибки в stdout/stderr.
G2.2: `docs/NOTIFICATIONS.md`; доставка выключена по умолчанию. Существующая БД
v1 не мигрируется при старте; offline migration с backup —
`npm.cmd run delivery:migrate -- <database> <new-backup-file>` после остановки
приложения и согласования изменения данных. Не запускать на рабочей БД из тестов.

## Локальные команды GI

Выполняются из корня проекта в PowerShell:

```powershell
.\tools\get-gi-context.ps1 -CommandText "gi start"
.\tools\check-instruction-kit-updates.ps1
git diff --check
```

Комплект GI принадлежит проекту. Канонический источник обновлений записан в
`tools/project-memory/instruction-kit.json`.

## Планирование и проверки

Подключение менеджера задач ещё не выбрано; внешняя синхронизация не настроена.
Основная проверка продукта: `npm.cmd test`; runtime при этом не остаётся запущенным.
Визуальная проверка и product integration остаются отдельными шагами.
Шаблон контракта: `templates/PROJECT_TESTING.template.md`.
Пользовательские изменения README и плана сохранять.
