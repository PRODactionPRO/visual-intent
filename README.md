# Visual Intent

Visual Intent — локальный мост визуальной обратной связи для команд разработки. Он добавляет небольшой слой аннотаций поверх запущенного локального веб-приложения, сохраняет структурированные задачи рядом с проектом и предоставляет их coding-агентам через MCP.

Текущая версия — намеренно компактный web-first MVP. В ней нет облачного backend, учётных записей, телеметрии и enterprise-функций.

## Что уже работает

- локальный reverse proxy для dev server на `localhost`;
- инжектируемый overlay с инструментами **Select**, **Draw**, **Comment**, **Tasks** и **Apply**;
- структурированные platform-neutral сущности `Surface`, `Node`, `Region`, `Frame`, `Relation`, `Annotation`, `Intent` и `Task`;
- файловое JSON-хранилище с атомарной записью, краткоживущей файловой блокировкой и проверкой конфликтов ревизий;
- проектные сессии, привязанные к репозиторию, и надёжно сохраняемые Apply-пакеты;
- Git-baseline каждого Apply: отдельные списки существовавших заранее изменений и файлов, изменённых самим пакетом;
- явное подтверждение в Tasks перед работой поверх незакоммиченных изменений;
- локальный HTTP API, защищённые токеном операции изменения и WebSocket-уведомления;
- явное разделение подключённой задачи Codex и автономного исполнителя на базе Codex SDK;
- MCP-инструменты для безопасного получения и завершения пакетов проектной задачей Codex;
- исходники локального Codex-плагина с автоматическим подключением сессии;
- пример интерфейса на React/Vite.

`Add task` сохраняет один визуальный комментарий в редактируемую локальную очередь. `Apply` атомарно создаёт надёжный пакет из всех готовых элементов. Подключённая задача Codex считается `host-attached`: daemon не пытается повторно открыть её через SDK, а оставляет пакет в `waiting_for_executor`, откуда эта же задача атомарно забирает его через MCP. Автономный SDK запускается только в явно выбранном режиме `isolated-worker` и владеет собственной задачей. Обратная связь никогда не удаляется незаметно.

## Требования

- Node.js 20.19 или новее;
- pnpm 11.18 (можно подключить через `corepack enable`).

## Запуск демонстрационного проекта

```bash
corepack enable
pnpm install
pnpm demo
```

Откройте <http://127.0.0.1:7310>. Не открывайте порт `5173`: там работает исходное демонстрационное приложение без изменений. На порту `7310` работает proxy Visual Intent с overlay.

Попробуйте следующий сценарий:

1. Нажмите **Select**, затем выберите зелёную кнопку «Start a conversation».
2. Введите описание изменения в карточке, которая откроется рядом с выбранным элементом.
3. Нажмите **Add task**, чтобы добавить комментарий в локальную очередь.
4. Откройте **Tasks**, чтобы отредактировать или удалить сохранённые комментарии.
5. Нажмите **Apply**, чтобы передать всю готовую очередь мосту coding-агента.

Задачи сохраняются в `.visual-intent/tasks.json` целевого репозитория; этот путь исключён из Git. Демонстрационный проект запускается без подключённого исполнителя, поэтому Apply можно исследовать безопасно: он создаёт ожидающий пакет, но не изменяет репозиторий примера.

## Использование с другим локальным веб-проектом

Сначала запустите обычный dev server этого проекта. Предположим, что он доступен по адресу `http://127.0.0.1:3000`.

В репозитории Visual Intent один раз установите зависимости и выполните сборку:

```bash
corepack enable
pnpm install
pnpm build
```

Затем запустите proxy. Замените абсолютный путь к репозиторию на реальный путь на вашем компьютере:

```bash
pnpm vip -- start \
  --target http://127.0.0.1:3000 \
  --port 7310 \
  --repo /absolute/path/to/your-project \
  --project your-project \
  --name "Ваш проект"
```

Откройте <http://127.0.0.1:7310>. Proxy всегда определяет путь к хранилищу из `--repo` и записывает задачи в `/absolute/path/to/your-project/.visual-intent/tasks.json`; обратная связь этого проекта никогда не сохраняется в репозитории самого продукта Visual Intent. Проект продолжает работать на исходном порту, а proxy перенаправляет запросы и WebSocket горячей перезагрузки и добавляет overlay в HTML-ответы.

MVP намеренно принимает только loopback-адреса и слушает только loopback-интерфейс. Если dev server возвращает сжатый HTML, несмотря на запрос proxy на несжатый ответ, страница будет проксирована, но overlay в неё не добавится.

## Направление Apply в правильную проектную задачу Codex

По умолчанию исполнитель имеет статус `disconnected`. Это сделано намеренно: запуск proxy из репозитория Visual Intent не должен заставлять задачу по разработке Visual Intent изменять любой продукт, который в этот момент показан в браузере.

Для уже существующей проектной задачи Codex после запуска proxy выполните следующую команду в терминале именно этой задачи:

```bash
node /absolute/path/to/visual-intent/apps/cli/dist/index.js attach \
  --daemon http://127.0.0.1:7310 \
  --repo /absolute/path/to/your-project
```

Плагин ищет идентификатор текущей задачи в метаданных MCP, затем в `CODEX_THREAD_ID` и `CODEX_SESSION_ID`. Если host не передал ни один из этих источников, остаётся безопасный явный параметр `threadId`; плагин не выбирает «последнюю активную» задачу по догадке. Перед подключением daemon проверяет канонический путь к репозиторию. В панели Tasks статус меняется с `disconnected` на `Codex · connected`. Следующий Apply сохраняет пакет со статусом `Waiting for Codex`, но не запускает второй процесс и не пишет в Thread Store. Текущая задача получает пакет через `visual_intent_list_batches` и `visual_intent_claim_batch` после следующего обращения пользователя. Автоматическое пробуждение уже открытой задачи из standalone-daemon пока не используется.

Если предпочтительнее отдельная автоматически созданная задача Codex, запустите proxy так:

```bash
pnpm vip -- start \
  --target http://127.0.0.1:3000 \
  --port 7310 \
  --repo /absolute/path/to/your-project \
  --project your-project \
  --executor isolated-worker
```

Первый Apply создаёт отдельную SDK-задачу, которой владеет Visual Intent, а последующие пакеты возобновляют только её. При необходимости можно явно передать ранее созданный Visual Intent worker через `--worker-thread <id>`; ID подключённой задачи Desktop сюда передавать нельзя.

Если в целевом репозитории уже есть незакоммиченные файлы, Apply сохраняется со статусом `needs_input`, а панель показывает их отдельным списком. Кнопка **«Продолжить поверх текущих изменений»** подтверждает только показанный снимок и только один пакет. Если файлы успели измениться, подтверждение не принимается до повторной проверки списка. После выполнения `preExistingDirtyFiles` остаётся исходным контекстом, а `batchChangedFiles` и совместимое поле `changedFiles` содержат только изменения относительно baseline. Флаг `--allow-dirty` оставлен как явно включаемое CLI-исключение для автоматизированных локальных сценариев.

### Плагин Codex

Исходники плагина находятся в `plugins/visual-intent`. Плагин добавляет:

- hook `SessionStart`, который подключает проектную задачу, если соответствующий proxy уже работает;
- skill проектной сессии, проверяющий точный Git-корень;
- MCP-инструменты для сессии, задач, пакетов, получения пакета в работу и сохранения результата.

Подключите marketplace репозитория и установите плагин:

```bash
codex plugin marketplace add PRODactionPRO/visual-intent --ref main
codex plugin add visual-intent@personal
```

Перед открытием новой задачи Codex в целевом репозитории запустите для него proxy Visual Intent. Перед первым запуском нового hook Codex просит пользователя подтвердить доверие: откройте `/hooks`, проверьте команду `node "$PLUGIN_ROOT/scripts/register-session.mjs"` и подтвердите именно это определение. Изменения плагина подхватываются новой задачей Codex после установки обновления. Команда CLI `attach`, описанная выше, остаётся быстрым способом подключения, не зависящим от плагина.

## Подключение другого coding-агента через MCP

Сначала соберите репозиторий, затем укажите в MCP-конфигурации агента тот же файл задач, который использует proxy.

Универсальная MCP-конфигурация:

```json
{
  "mcpServers": {
    "visual-intent": {
      "command": "node",
      "args": [
        "/absolute/path/to/visual-intent/apps/cli/dist/index.js",
        "mcp",
        "--store",
        "/absolute/path/to/your-project/.visual-intent/tasks.json",
        "--repo",
        "/absolute/path/to/your-project"
      ]
    }
  }
}
```

TOML-конфигурация Codex использует ту же команду и аргументы:

```toml
[mcp_servers.visual_intent]
command = "node"
args = [
  "/absolute/path/to/visual-intent/apps/cli/dist/index.js",
  "mcp",
  "--store",
  "/absolute/path/to/your-project/.visual-intent/tasks.json",
  "--repo",
  "/absolute/path/to/your-project"
]
```

Параметр `--repo` даёт файловому мосту возможность проверять Git-baseline; без него операции чтения остаются совместимыми, но подтверждение dirty-worktree безопасно отклоняется. Файловый мост предоставляет восемь инструментов:

- `visual_intent_list_tasks` — показать все задачи или отфильтровать их по статусу;
- `visual_intent_list_batches` — показать Apply-пакеты и их статусы;
- `visual_intent_retry_batch` — повторно запустить заблокированный или неудачный пакет после устранения причины;
- `visual_intent_approve_dirty_batch` — после явного согласия пользователя подтвердить точный dirty-baseline одного пакета;
- `visual_intent_claim_batch` — атомарно забрать один пакет из очереди и перевести его в `in_progress`;
- `visual_intent_get_task` — получить полный визуальный контекст и данные ревизии;
- `visual_intent_finish_batch` — сохранить результат реализации всего пакета;
- `visual_intent_update_task` — изменить инструкцию либо записать статус и необязательный результат реализации.

## Локальный API

Все endpoint используют origin proxy Visual Intent:

```text
GET   /_visual-intent/api/health
GET   /_visual-intent/api/session
POST  /_visual-intent/api/session/attach
GET   /_visual-intent/api/tasks?status=ready
GET   /_visual-intent/api/tasks/:id
POST  /_visual-intent/api/tasks
PATCH /_visual-intent/api/tasks/:id
DELETE /_visual-intent/api/tasks/:id
POST  /_visual-intent/api/tasks/apply
GET   /_visual-intent/api/batches
GET   /_visual-intent/api/batches/:id
POST  /_visual-intent/api/batches/:id/claim
POST  /_visual-intent/api/batches/:id/finish
POST  /_visual-intent/api/batches/:id/retry
POST  /_visual-intent/api/batches/:id/approve-dirty
WS    /_visual-intent/ws
```

Daemon хранит всё локальное состояние проверки в `.visual-intent/` целевого репозитория: `tasks.json` содержит задачи, проектную сессию, Apply-пакеты и результаты; файл `connection.json` с правами `0600` содержит loopback URL, вычисленный путь к хранилищу задач и случайный токен сессии, который используется для операций изменения, доступа по WebSocket, подключения через CLI, hook и MCP-мост плагина. CLI добавляет `/.visual-intent/` в локальный Git exclude целевого репозитория. Никогда не добавляйте эти файлы в коммит.

Для быстрой проверки:

```bash
curl http://127.0.0.1:7310/_visual-intent/api/health
curl http://127.0.0.1:7310/_visual-intent/api/tasks
```

## Проверка репозитория

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Или запустите ту же последовательность одной командой:

```bash
pnpm check
```

## Структура репозитория

```text
apps/
  cli/             локальный daemon, reverse proxy, HTTP/WebSocket API и CLI
  example-web/     тестовый интерфейс на React/Vite
packages/
  protocol/        стабильные сущности, Zod-контракты и JSON Schema
  core/            жизненный цикл задач и storage port
  file-store/      adapter локального JSON-хранилища
  sdk/             типизированный HTTP-клиент
  web-overlay/     инжектируемый браузерный UI без зависимостей
  mcp-server/      мост coding-агента через MCP stdio
plugins/
  visual-intent/   Codex hook, skill и MCP-мост к daemon
docs/
  PRODUCT.md
  ARCHITECTURE.md
  PROTOCOL.md
  PLATFORM-ROADMAP.md
  FUTURE-MEDIA-AND-USAGE.md
```

Подробности: [продукт](docs/PRODUCT.md), [архитектура](docs/ARCHITECTURE.md), [протокол](docs/PROTOCOL.md), [платформенный roadmap](docs/PLATFORM-ROADMAP.md) и дискуссионный документ о [будущей работе с медиа, хранением и стоимостью](docs/FUTURE-MEDIA-AND-USAGE.md).

## Лицензия

MIT
