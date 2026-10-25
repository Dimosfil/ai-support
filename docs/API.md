# HTTP API v1

Session `capabilities.externalDelivery` отражает доступность явно подключённого
worker через `getDeliveryStatus`; по умолчанию false. Это не статус отправки
отдельного сообщения и не подтверждение подключения реальной Bot API.
`capabilities.telegram` остаётся false: работающий вход Telegram-бота пока не подключён.

Все бизнес-маршруты требуют `Authorization: Bearer <key>` в локальном стенде.
Ключи генерируются локально; ID/роль/tenant из тела запроса не принимаются.
При встраивании HTTP-хост заменяет identity-адаптер своей проверкой сессии.
Ошибки: `{error:code}`; неизвестные поля тела и query отклоняются.

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/health` | Liveness процесса, не доказательство доступности БД |
| GET | `/api/v1/session` | Principal, лимиты и capabilities |
| GET | `/api/v1/tickets?before=<seq>&limit=30` | Свои обращения/операторская очередь |
| POST | `/api/v1/tickets` | Создать: `{subject,body}` |
| GET | `/api/v1/tickets/<id>` | Текущие данные, version и allowedTransitions для текущей роли |
| GET | `/api/v1/tickets/<id>/messages` | Переписка с фильтром видимости |
| GET | `/api/v1/tickets/<id>/audit` | Аудит оператора |
| POST | `/api/v1/tickets/<id>/commands` | Сообщение, статус или назначение |

`messages` и `audit` поддерживают ту же пагинацию `before/limit`.
Все POST требуют `Content-Type: application/json` и `Idempotency-Key`.
Создание: HTTP 201; replay и изменение: HTTP 200. Ответ записи — receipt:
`{id,version,messageId?,replayed}`. Текущую версию и состояние получают через GET.

Команды:

```json
{"type":"message","version":1,"body":"Уточните, пожалуйста, детали","visibility":"public"}
```

```json
{"type":"status","version":2,"status":"waiting_user"}
```

```json
{"type":"assignment","version":3,"assigned":true}
```

`visibility:internal` — заметка оператора. Из new нельзя сразу перейти в
waiting_user: сначала in_progress. Assign принимает boolean, а не account ID.

| HTTP | Основные коды |
| --- | --- |
| 400 | invalid_subject, invalid_body, version_required, idempotency_key_required, unknown_field, invalid_limit, invalid_cursor |
| 401 | unauthorized |
| 403 | forbidden, user_required |
| 404 | not_found (включая чужие обращения) |
| 409 | version_conflict, idempotency_conflict, invalid_transition |
| 413 / 415 | request_too_large / json_required |
| 429 | rate_limited, Retry-After: 60 |
| 503 | service_unavailable или server_busy; принятие не подтверждено |

При неизвестном результате сети/503 повторите исходное тело и ключ. После 409
обновите состояние; не меняйте версию старой команды и не повторяйте автоматически
её с новым ключом. Другая намеренная операция использует новый ключ.
HTTP не включает CORS-доступ, cookie-login, загрузку вложений или Telegram.
Пример встраивания и границы доверия: [контракт ядра](CORE_CONTRACT.md).
