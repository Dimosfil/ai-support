# Support core v1 — реализация и инварианты

Дата: 23.10.2026. Стадия: локальная основа G0/G1, без приёмки всей системы.
Продуктовый план: `../../../SUPPORT_SYSTEM_PLAN.md`.
Авторитетный контракт: `../../../docs/CORE_CONTRACT.md`; HTTP: `../../../docs/API.md`.

## Механизм и владельцы

- HTTP `src/http/app.mjs` проверяет транспорт, вызывает trusted authenticate,
  передаёт principal и команду сервису; не содержит SQL и правил перехода статусов.
- `src/core/support-service.mjs` владеет областью прав, нормализацией команды,
  идемпотентностью, version precondition, автоматическим reopen и записью аудита.
- `src/core/domain.mjs` владеет валидаторами и переходами статусов.
- `src/storage/sqlite-store.mjs` и `schema.sql` владеют SQL и одной атомарной
  транзакцией ticket/message/audit/notification intent/replay receipt.
- `src/adapters/local-identity.mjs` — заменяемый dev-адаптер. Продукт должен
  предоставить свою серверную identity, а не передавать пользовательские заголовки.
- UI `src/web/` — потребитель API; права всегда повторно проверяются ядром.

## Сохраняемые гарантии

User видит только свои tickets/public messages внутри tenant. Operator видит
очередь и аудит только своего tenant. Чужой UUID даёт not_found. Internal note
не попадает в public history или notification intents. Операции versioned;
устаревший writer ничего не меняет. Replay идентичен по tenant/actor/operation/key
и fingerprint, выполняется до проверки устаревшей версии, после проверки доступа.
Любая ошибка commit-пути откатывает все записи, включая receipt и intent.

Браузер хранит pending payload/key раздельно по identity и endpoint. После
неопределённого результата сначала восстанавливает прежнюю операцию. Изменение
версии при refresh не создаёт нового ключа для того же намерения. Черновик
остаётся при 409/429/503 и сетевой ошибке. Token не сохраняется в storage.

## Проверка и границы

`tests/core.test.mjs`: реальная SQLite, atomic rollback, reopen, durable replay,
права, заметки, rate limit, статусы и курсоры.
`tests/http.test.mjs`: реальные HTTP-запросы, UTF-8 readback, конкурентные writers,
ошибки записи, capability flags, CSP и запрет статических локальных файлов.
`tests/browser-state.test.mjs`: защита pending-запроса от смены version/текста.
`tests/config.test.mjs`: настройки и setup без перезаписи/утечки ключей.
24 теста прошли. Отдельно прошёл штатный запуск src/server.mjs с dev-конфигурацией:
health, authenticated session и UTF-8 HTML. После проверки процесс остановлен.

Механизм G2.2 реализован отдельно: [delivery-g22.md](delivery-g22.md), контракт
[NOTIFICATIONS.md](../../../docs/NOTIFICATIONS.md). Публичные операции ядра v1
сохранены. SQLite поддерживает v1/v2; вложенные синхронные unit of work используют
savepoint для атомарности Telegram receipt вместе с core writes.

Нет вложений, guest-flow, живого Telegram-бота, incidents, реальной
product identity, резервного канала или production backup/retention. Не считать
прохождение локальных тестов приёмкой G1–G4. Synchronous SQLite рассчитан на один
локальный процесс. Node sqlite experimental в проверенной версии; зависимость
изолирована адаптером, обновление требует повторных integration tests.
