# Связанные проекты

## avito-bot — источник подхода

По поручению пользователя изучены app/process_unread.py, autoreply_worker.py,
manager_notification_service.py и storage.py. Заимствованы идеи фонового цикла,
восстановления pending, отдельного транспорта и проверки менеджерского режима.
Python/source, Avito-модель, sales-правила и runtime-state не копируются.
Наша атомарная очередь, bounded retry, lease и unknown определены ядром ai-support.

## ai-media-client — будущий потребитель

Авторизовано изучение локального проекта при разработке адаптеров. Фокус:
tools/project-memory/specs/features/support.md, docs/support-implementation-plan.md,
src/services/telegram-bot.js, telegram-link.js и серверная identity.
Support runtime пока не подключён; изменение этого repo в текущий шаг не входит.

Решение пользователя: сначала delivery/адаптеры в ai-support, живое подключение
сайта и бота следующим шагом. Перед ним заново проверить контракт и инструкции.
Product владеет account/session/roles и Telegram link. Ветку поддержки поставить
до генерационных проверок каталога/баланса и не менять generation draft.
Оба канала должны вызывать один support service и одну историю.

Форма production-поставки/БД/receiver пока не выбрана. Запрещена runtime/build
зависимость от соседнего checkout и чтение его secrets/БД из ai-support.
Настройка каталогов и реальных отправок требует доверенных host adapters;
новые маршруты ai-media-client не выдумывать. Подробности —
[delivery-g22.md](../delivery-g22.md) и [NOTIFICATIONS.md](../../../../docs/NOTIFICATIONS.md).
