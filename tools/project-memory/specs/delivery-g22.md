# G2.2: устойчивые уведомления

Дата: 2026-10-25. Согласованная граница: код/адаптеры ai-support; подключение
работающего сайта/бота ai-media-client — следующий отдельный шаг.
Пользовательский контракт: [NOTIFICATIONS.md](../../../docs/NOTIFICATIONS.md).

## Владение

- SupportService остаётся владельцем прав, версий, повтора записи, атомарного
  message/audit/intent. NotificationDispatcher не пишет сообщения и не меняет тикеты.
- SqliteDeliveryStore владеет claims/lease-token, jobs/attempts и агрегатом intent.
  Отдельных брокеров/БД нет. Новая БД v2; v1 поддерживается без автоматического DDL.
- Product host владеет session/tenant/role, recipient directory, opt-in,
  Telegram link/revision и явно выбранным support-контекстом.
- Transports владеют только протоколом отправки. Worker не знает account-таблиц,
  endpoint не берётся из обращения; сырой ответ/ошибка не пишутся в попытки/логи.

## Алгоритм

1. После core commit claim плана recipients делается BEGIN IMMEDIATE.
2. Resolve вне транзакции; snapshot содержит только id/channel/binding/principal.
   Ошибка — bounded retry; [] — no_recipients, без ложного sent.
3. Jobs на адресатов сохраняются транзакционно. Независимый claim каждого job.
4. Перед каждой отправкой host повторно проверяет права и маршрут, worker
   сравнивает snapshot и tenant/audience/owner; public message перечитывается.
5. Транзакционный переход leased→sending предшествует сети. После него любой
   неопределённый исход — unknown без auto-retry. До отправки ошибки проверок
   допускают bounded retry. Отзыв маршрута — skipped.
6. Retry только при явном отказе транспорта до принятия; exponential backoff,
   retry_after не сокращается maxDelay. Успешный адресат повторно не отправляется.
7. Истёкший leased восстанавливается; sending становится unknown. CAS lease-token
   не даёт запоздавшему worker отправить/подтвердить чужую задачу.
8. Intent pending при активных задачах; sent только при всех sent, иначе failed.
   Детальные причины остаются в deliveries/attempts, не заменяются агрегатом.

Обработчик и host callbacks ограничены timeout; start/stop принадлежат host runtime.
Настройки и defaults определяет dispatcher. status выдаёт счётчики/обезличенный
код, а не переписку. Public HTTP session лишь отражает доступность worker,
telegram capability остаётся false до подключения работающего бота.

## Два входа

fromProduct берёт principal из authenticateProduct, не command; create/reply
вызывают существующий core. fromTelegram сначала authenticateTelegram, затем
только private text + проверенная binding/support-mode. Event key — bot source
и update_id; receipt/fingerprint и core writes в одной транзакции/savepoint.
Повтор не переадресуется при переключении выбранного тикета или relink.
Internal не принимается в пользовательских адаптерах. Авторизованный оператор
пользуется существующим ядром/API, никакого нового operator bypass нет.

## Миграция и воспроизведение

delivery-schema.sql добавляет plans/deliveries/attempts/inbound_receipts и v2.
migrate-delivery.mjs делает согласованный backup через node:sqlite backup,
проверяет v1, применяет DDL транзакционно. Запуск только offline и явно, не startup.
Тесты используют синтетическую v1 и восстанавливают backup с чтением обращения.

Evidence: tests/delivery.test.mjs, tests/core.test.mjs, tests/http.test.mjs.
Итоговая проверка 2026-10-25: npm test 45/45; node --check src/scripts/tests/config;
штатный отдельный CLI-процесс с authenticated HTTP → background delivery;
git diff --check. Тестовые процессы/приёмники остановлены.
Проверки включают реальные SQLite/локальные HTTP, Unicode, authority, rollback,
backoff, unknown, reopen, competing leases, recipient fanout, runtime lifecycle.
Реальная Bot API, product auth/roles/receiver и Telegram support-mode не проверены:
это согласованная граница следующего подключения, а не готовый production.

## GI installation

8 accepted file migrations 2026.10.24.1–2026.10.25.3 установлены и проверены
с сохранением project-owned инструкций; pending=0. Codex/OpenCode manifests
сконфигурированы, native trust/activation/live delivery не проверены. Используется
ручной Work/Complete. Metadata checkpoint не доказывает работу native hooks.
