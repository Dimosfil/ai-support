# G2.2: доставка уведомлений и входные адаптеры

Реализовано в ai-support. Живое подключение ai-media-client, его сайта,
Telegram-бота, account/session/link и операторских ролей — отдельный следующий шаг.
Его исходники, БД и Compose в этой задаче не менялись. Автоответов AI здесь нет.

## Как проходит сообщение

`product session / проверенный Telegram update → createSupportIngress →
SupportService → сообщение + аудит + notification_intent одним commit →
NotificationDispatcher → актуальная проверка получателя → transport → результат`.

Оба входа используют один service/store. Канал не создаёт отдельную историю.
Публичное сообщение пользователя уведомляет операторов своего tenant;
публичный ответ оператора — владельца обращения. Внутренняя заметка не создаёт intent.
Подтверждение сохранения сообщения не зависит от результата внешней отправки.

## Подключение в сервер продукта

```js
import {
  SupportService, SqliteStore, SqliteDeliveryStore, NotificationDispatcher,
  createSupportIngress, createTelegramTransport, createProductTransport,
} from '@ai-support/core';

const store = new SqliteStore(databasePath);
const service = new SupportService(store);
const ingress = createSupportIngress({
  service, store,
  authenticateProduct,       // request → проверенный {tenant,subject,role}
  authenticateTelegram,      // request → true только для доверенного gateway/webhook
  resolveTelegram,           // {userId,chatId} → актуальная привязка/support-контекст
  telegramSource: botSource, // стабильный не секретный ID бота, а не его token
});
const worker = new NotificationDispatcher({
  store: new SqliteDeliveryStore(store),
  resolveRecipients, revalidateRecipient,
  transports: {
    telegram: createTelegramTransport({ token: telegramToken }),
    product: createProductTransport({ url: receiverUrl, token: receiverToken }),
  },
});
worker.start();
// При завершении сначала закончить входные запросы, затем:
await worker.stop();
store.close();
```

Передаются только реально настроенные transports. Ядро не читает соседние
репозитории, таблицы account продукта или его локальные secrets.
Нужна фиксированная поставка пакета/исходников либо согласованный защищённый API.

### Вход из сервиса

`await ingress.fromProduct(request, command, idempotencyKey)`.

- Создать: `{action:'create',subject,body}`.
- Ответить: `{action:'reply',ticketId,version,body}`.

Principal берётся исключительно из `authenticateProduct(request)`. Адаптер
предназначен для пользовательского входа; операторские действия идут через
существующий SupportService/HTTP API. Повторы, версии, лимиты и права остаются
у ядра. Произвольный tenant/owner из command не определяет identity.

### Вход из Telegram

`await ingress.fromTelegram(update, request)` принимает только текстовые
`update.message` из личного чата пользователя, прошедшего `authenticateTelegram`.
При webhook функция проверяет секрет/подлинность транспорта до поиска аккаунта;
при polling доверие устанавливает существующий серверный gateway. Один `from.id`
не подтверждает подлинность HTTP-запроса.

`resolveTelegram({userId,chatId})` возвращает:

```js
{
  principal: { tenant, subject: accountId, role: 'user' },
  enabled: true,
  binding: linkRevision, // меняется при unlink/relink и смене владельца/адреса
  support: {
    active: true,
    action: 'reply', ticketId, version,
    // Для нового обращения: action:'create', subject:'Тема'
  },
}
```

Support-контекст выбирается и хранится доверенным сервером. Вход/выход из режима,
выбор обращения, команды и связывание аккаунта относятся к живому подключению G3.
Адаптер отказывает при выключенном support-режиме, отсутствии привязки, групповом
чате и вложениях; тексты поддержки не отправляются в генерации. Вызывающий бот
должен перехватывать support-ветку до проверки тарифа/баланса/генерационного draft
и не превращать ошибку поддержки в запрос генерации.

Update дедуплицируется по `telegramSource + update_id`. Receipt и изменения ядра
сохраняются одной транзакцией с вложенным savepoint. Повтор проверяет актуальную
identity/привязку/доступ и возвращает исходный receipt даже после смены выбранного
обращения. После relink другому аккаунту старый update не переадресуется.
Результат `version_conflict` требует обновления выбранного обращения, без
молчаливого повтора записи на новой версии.

## Каталог получателей: обязанность продукта

`resolveRecipients({tenant,ticketId,owner,audience})` возвращает до 100 записей:

```js
{ id: routeId, channel: 'telegram', binding: linkRevision,
  principal: {tenant,subject,role} }
```

`id` уникален в одном intent и стабилен для адресата/канала. `binding` меняется
при изменении назначения маршрута, роли, владельца или Telegram-привязки.
Snapshots содержат только routing identity; токены, URL и тела сообщений туда
не записываются. В одной рассылке могут быть Telegram и product-получатели.

`revalidateRecipient(snapshot,{tenant,ticketId})` перед **каждой** попыткой
читает текущие account/link/настройки и возвращает тот же snapshot плюс
`enabled:true,address` (chat ID для Telegram), либо `null`. Функция обязана
проверять актуальную роль и право на конкретное обращение, блокировку, unlink,
opt-in и принадлежность tenant; системный API key канала этого не заменяет.
Ядро доставки дополнительно проверяет tenant/роль/владельца и совпадение snapshot.
Отзыв/смена привязки приводит к `skipped`, без отправки по новому адресу.

Ошибка каталога повторяется с backoff; пустой список — окончательное отсутствие
получателей (`no_recipients`), а не успешная доставка. Пока каталог не настроен,
не включайте worker. Пример конфигурации намеренно выбрасывает ошибку каталога.

## Доставка и состояния

Таблицы схемы v2: `notification_plans`, `notification_deliveries`,
`notification_attempts`, `support_inbound_receipts`. Все расположены в той же БД.
Сетевой запрос никогда не выполняется внутри SQLite-транзакции.

- `pending → leased → sending → sent` — канал подтвердил приём; это не прочтение.
- Подтверждённый временный отказ возвращает `pending` с backoff.
- Постоянный отказ или исчерпание попыток — `failed`.
- Отзыв прав/маршрута — `skipped`.
- Timeout, потеря ответа, неоднозначный ответ или crash во время `sending` —
  `unknown`, без автоматической повторной отправки. Оператор сверяет канал перед
  отдельным разрешённым повтором; отдельного UI/команды повтора пока нет.

Lease выдаётся атомарно. Истёкший `leased` можно подобрать; истёкший `sending`
считается `unknown`. Старый worker не может завершить/отправить задачу с потерянным
lease. Успешные адресаты не отправляются повторно из-за отказа другого канала.
Порядок при backoff может отличаться от порядка истории; история остаётся в ядре.

Политика по умолчанию: 5 попыток, baseDelayMs=1000, maxDelayMs=60000,
leaseMs=30000, sendTimeoutMs=10000, intervalMs=1000, batchSize=20.
Повторный интервал растёт экспоненциально. `retry_after` канала имеет приоритет
над maxDelayMs (ограничение принимаемой задержки — сутки).
Resolve/revalidate/send ограничены sendTimeoutMs; sendTimeoutMs < leaseMs.
Один локальный цикл не выполняется параллельно самому себе; следующий стартует
после завершения и intervalMs. Большие/распределённые установки не проверялись.

`worker.status()` возвращает обезличенные счётчики intent/delivery, состояние
цикла, время и код ошибки. Детали попыток хранятся в закрытой БД, в веб/API пока
не публикуются. `notification_intents.state='sent'` только когда все адресаты
подтвердили приём; при unresolved задачах — pending; остальные итоги — failed.
Для различения `failed/skipped/unknown` смотрите deliveries, а не только intent.

### Транспорты

Telegram использует `sendMessage`, UTF-8 и обычный текст без parse_mode. Длинное
сообщение становится превью с указанием, что полный текст находится в обращении.
Подтверждённый 429 учитывает retry_after; неоднозначный результат не повторяется.
Параметры сверены с [официальной Bot API](https://core.telegram.org/bots/api#sendmessage),
[ResponseParameters](https://core.telegram.org/bots/api#responseparameters) и
[защитой webhook](https://core.telegram.org/bots/api#setwebhook).

Product transport — заготовленный контракт приёмника уведомлений, **такого
маршрута в ai-media-client пока нет**. Настроенный сервер получает `POST` JSON:
`{notification:{id,tenant,ticketId,messageId,subject,body,audience},
recipient:{id,subject,binding}}`, bearer token и `Idempotency-Key=notification.id`.
Он обязан проверить token/tenant/получателя/привязку, сохранить уведомление
идемпотентно, вернуть 2xx `{accepted:true}` после сохранения. Только явное
`{accepted:false,retryable:true,retryAfterMs}` с 429/503 разрешает повтор.
Остальные неоднозначные результаты — unknown; явные 400/401/403/404/413/422 с
`accepted:false` — failed. Приёмник не должен отвечать accepted:false после commit.

Endpoints задаёт доверенная конфигурация, не содержимое обращения. Разрешены
HTTPS и loopback HTTP для локальной проверки; redirects запрещены. Токены читаются
серверным модулем из окружения/secret store, не попадают в БД попыток/логи/браузер.

## Локальный runtime и миграция

По умолчанию доставка выключена. Новая БД создаётся сразу в v2; существующая v1
продолжает обслуживать сайт. Запуск не мигрирует её автоматически, включение
worker для v1 выдаёт обезличенный отказ и сохраняет работу ядра.

Для существующей БД сначала остановите приложение и согласуйте миграцию данных,
затем выполните с новым путём backup:

```powershell
npm.cmd run delivery:migrate -- .\data\support.sqlite .\data\support-before-g22.sqlite
```

Команда создаёт согласованный SQLite backup, сохраняет старые обращения/intents
и транзакционно добавляет v2. Backup не перезаписывается. Возврат к v1 — остановка
приложения и восстановление проверенной копии, с учётом потери изменений после
backup. Самостоятельно удалять WAL/SHM работающей БД нельзя. В этой задаче
миграция исполнялась только на синтетической БД теста, не на пользовательских данных.

Скопируйте `config/delivery-adapters.example.mjs` в `.local/delivery-adapters.mjs`
и реализуйте каталог/проверку через сервер продукта. В `.local/runtime.json`:

```json
{ "delivery": { "enabled": true, "adapterModule": "./.local/delivery-adapters.mjs" } }
```

Этот фрагмент дополняет существующую конфигурацию. Относительные пути считаются
от cwd проекта. `delivery.policy` может переопределять перечисленные настройки.
Опциональные env примера: SUPPORT_TELEGRAM_BOT_TOKEN,
SUPPORT_PRODUCT_NOTIFICATION_URL, SUPPORT_PRODUCT_NOTIFICATION_TOKEN.
Ненастроенная/невалидная доставка отключается с обезличенным сообщением; создание
обращений продолжает работать. Само включение — разрешение серверу на отправки.

## Проверки и границы готовности

`npm.cmd test`: настоящая SQLite, локальные HTTP Telegram/product-приёмники,
Unicode readback, оба входа/одна история, повторы updates, rollback, tenant/owner,
internal, отзыв привязки, backoff, crash/lease, несколько адресатов/worker,
timeout/unknown, backup/restore и подключение runtime-модуля.
Это проверка механизма в ai-support. Реальная Bot API, сессии/права/маршрут
уведомлений ai-media-client, его UI и бот проверяются при живом подключении.
