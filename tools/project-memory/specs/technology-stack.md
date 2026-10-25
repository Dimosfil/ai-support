# Technology Stack

Проверено: 25.10.2026. Источники: package.json, package-lock.json, src/, tests/.

| Слой | Реализация | Контракт |
| --- | --- | --- |
| Runtime | Node.js 24.14.1; engines >=24.14.1 <25 | ESM, без компиляции |
| Domain/application | JavaScript ESM | src/core/, публичные exports в src/index.mjs |
| Storage | SQLite 3.51.2 через node:sqlite | SqliteStore; FK, WAL, synchronous FULL; новая schema v2, v1 без auto-migration |
| Delivery | NotificationDispatcher / SQLite leases и attempts | Telegram/product HTTP transports через встроенный fetch; host directory/revalidation; выключено по умолчанию |
| Inbound adapters | createSupportIngress | Product identity и аутентифицированные Telegram updates; одна история и durable update receipts |
| Transport | node:http | HTTP API /api/v1; injectable authenticate |
| Web | HTML/CSS, browser ES modules | Те же API и серверные права; sessionStorage для черновиков |
| Identity | Локальные случайные bearer keys, SHA-256 hashes | Только loopback; product host заменяет адаптер |
| Tests | node:test + node:assert | Реальные SQLite/HTTP, синтетические identity |
| Dependencies | Нет внешних npm-пакетов | package-lock.json |

Команды: npm.cmd run dev:setup; npm.cmd start; npm.cmd test;
offline migration: npm.cmd run delivery:migrate -- <database> <new-backup-file>.
Настройки: config/support.example.json → ignored .local/runtime.json,
SUPPORT_CONFIG выбирает другой файл; config-service отключён.
Data: выделенный ignored data/; private credentials/config: ignored .local/.

Ограничения: node:sqlite experimental в проверенном runtime, синхронные транзакции,
один локальный процесс. Нет production-hosting, HTTPS/production sessions,
uploads, guests, живой интеграции Telegram/ai-media-client и diagnostics.
Диспетчер/адаптеры проверены локально; реальные external sends не выполнялись.
Текущий SQLite не является выбранной БД для любого будущего продукта автоматически.
Эксплуатационные детали: ../../../docs/LOCAL_RUN.md.
