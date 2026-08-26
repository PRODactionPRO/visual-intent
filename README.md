# Visual Intent

Visual Intent — локальный мост визуальной обратной связи для команд разработки. Он добавляет небольшой слой аннотаций поверх запущенного локального веб-приложения, сохраняет структурированные задачи рядом с проектом и предоставляет их coding-агентам через MCP.

Текущая версия — намеренно компактный web-first MVP. В ней нет облачного backend, учётных записей, внешней телеметрии и enterprise-функций. Измерения продукта сохраняются только локально в папке конкретного проекта.

## Что уже работает

- локальный reverse proxy для dev server на `localhost`;
- инжектируемый overlay с инструментами **Select**, **Draw**, **Comment**, **Tasks** и **Apply**;
- структурированные platform-neutral сущности `Surface`, `Node`, `Region`, `Frame`, `Relation`, `Annotation`, `Intent` и `Task`;
- файловое JSON-хранилище с атомарной записью, краткоживущей файловой блокировкой и проверкой конфликтов ревизий;
- проектные сессии, привязанные к репозиторию, и надёжно сохраняемые Apply-пакеты;
- панель задач с вкладками **Backlog**, **In progress** и **Ready**, локальной нумерацией каждой Apply-итерации, навигацией к комментарию и группировкой отправленных задач по Apply; якоря на странице показываются только для текущего Backlog;
- независимая оценка качества от 1 до 5 звёзд, связанные итерации правок `accepted` / `needs_revision` / `not_accepted` и история раундов;
- Git-baseline каждого Apply: отдельные списки существовавших заранее изменений и файлов, изменённых самим пакетом;
- Git-baseline и настраиваемая dirty-policy: `allow-host-attached` по умолчанию либо точное подтверждение fingerprint;
- локальный HTTP API, защищённые токеном операции изменения и WebSocket-уведомления;
- явное разделение подключённой задачи Codex и автономного исполнителя на базе Codex SDK;
- отдельные роли `controller`, активного `executor` и постоянной записи `sdkWorker`: рабочий чат наблюдает проект, не перехватывая очередь автономного worker;
- локальный проектный briefing `.visual-intent/context.md`, снимок которого фиксируется внутри каждого Apply;
- MCP-инструменты для безопасного получения и завершения пакетов проектной задачей Codex;
- локальные append-only события, execution-записи, точный batch usage там, где его сообщает adapter, и CLI-команда `metrics`;
- исходники локального Codex-плагина с автоматическим подключением сессии;
- локальное распакованное Chrome Extension для визуальных референсов с внешних сайтов;
- пример интерфейса на React/Vite.

`Add task` сохраняет один визуальный комментарий в редактируемую локальную очередь. `Apply` атомарно создаёт надёжный пакет из всех готовых элементов. В host-attached режиме подключённая задача Codex сама забирает пакет `waiting_for_executor` через MCP. В режиме `isolated-worker` daemon запускает отдельную SDK-задачу и получает точный usage её turn; подключённый рабочий чат остаётся controller и не заменяет этого исполнителя. Обратная связь никогда не удаляется незаметно.

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

Для проверки автоматизированной навигации откройте
<http://127.0.0.1:7310/navigation-ready-demo.html>. Fixture оставляет HMR
WebSocket открытым, но Visual Intent всё равно публикует собственный постоянный
маркер `data-visual-intent-bootstrap`. Контракт и рекомендуемый
`page.waitForFunction` описаны в [docs/NAVIGATION-READY.md](docs/NAVIGATION-READY.md).

Попробуйте следующий сценарий:

1. Нажмите **Select**, затем выберите зелёную кнопку «Start a conversation».
2. Введите описание изменения в карточке, которая откроется рядом с выбранным элементом.
3. Нажмите **Add task**, чтобы добавить комментарий в локальную очередь.
4. Откройте **Tasks**, чтобы отредактировать или удалить сохранённые комментарии.
5. Нажмите **Apply**, чтобы передать всю готовую очередь мосту coding-агента.

Задачи, пакеты и пользовательские оценки сохраняются в `.visual-intent/tasks.json` целевого репозитория; события и выполнения — в `.visual-intent/usage/events.jsonl` и `.visual-intent/usage/executions.jsonl`. Локальная аналитика соединяет обе группы источников: без `tasks.json` невозможно посчитать итерации и принятые результаты, а без журналов `usage/` — попытки, длительность и токены. Вся директория исключена из Git. Демонстрационный проект запускается без подключённого исполнителя, поэтому Apply можно исследовать безопасно: он создаёт ожидающий пакет, но не изменяет репозиторий примера.

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
pnpm vip start \
  --target http://127.0.0.1:3000 \
  --port 7310 \
  --repo /absolute/path/to/your-project \
  --project your-project \
  --name "Ваш проект"
```

Откройте <http://127.0.0.1:7310>. Proxy всегда определяет путь к хранилищу из `--repo` и записывает задачи в `/absolute/path/to/your-project/.visual-intent/tasks.json`; обратная связь этого проекта никогда не сохраняется в репозитории самого продукта Visual Intent. При первом запуске рядом создаётся `.visual-intent/context.md`: туда можно записать устойчивую цель продукта, архитектурные ограничения, Figma-ссылку и команды проверки. Apply сохраняет снимок этого файла, поэтому уже отправленный пакет не меняет смысл при последующем редактировании briefing. Проект продолжает работать на исходном порту, а proxy перенаправляет запросы и WebSocket горячей перезагрузки и добавляет overlay в HTML-ответы.

MVP намеренно принимает только loopback-адреса и слушает только loopback-интерфейс. Если dev server возвращает сжатый HTML, несмотря на запрос proxy на несжатый ответ, страница будет проксирована, но overlay в неё не добавится.

### Постоянный proxy на macOS и диагностика

Для ежедневной работы proxy можно установить как пользовательский LaunchAgent,
который не завершается вместе с временным терминалом:

```bash
pnpm vip service install \
  --target http://127.0.0.1:3000 \
  --port 7310 \
  --repo /absolute/path/to/your-project \
  --project your-project \
  --executor isolated-worker
```

Visual Intent не запускает dev server целевого проекта — он должен работать
отдельно. Состояние сервиса и всего локального контура проверяется без изменений
файлов:

```bash
pnpm vip service status --repo /absolute/path/to/your-project
pnpm vip doctor --repo /absolute/path/to/your-project
```

`service install`, `service start` и `service restart` считаются успешными
только после двух проверок: LaunchAgent действительно имеет живой PID, а
сверенный по identity health-ответ подтверждает ожидаемые репозиторий, URL proxy, сессию и
конкретный экземпляр daemon. Один канонический репозиторий может иметь только
один процесс Visual Intent; foreground CLI и LaunchAgent не смогут незаметно
запуститься параллельно.

Команды управления, защита активного Apply, логи и ignore-рецепты подробно
описаны в [руководстве по эксплуатации](docs/OPERATIONS.md).

## Локальное Chrome Extension для внешних референсов

Расширение позволяет выбрать элемент на любом обычном сайте, добавить комментарий и до трёх изображений, а затем сохранить задачу в одном из уже запущенных проектов Visual Intent. Оно не скачивает JavaScript, cookies, историю или сайт целиком. В задачу попадают URL без query/fragment, ограниченное дерево HTML-элементов, безопасные атрибуты и allowlist вычисленных CSS-стилей. Изображения добавляются только явным действием пользователя: через выбор файла, drag-and-drop или вставку из буфера.

Сначала соберите CLI и расширение:

```bash
pnpm build
```

Запустите один общий локальный Bridge:

```bash
pnpm vip bridge
```

Команда покажет шестизначный код подключения и будет слушать только `http://127.0.0.1:7309`. Каждый проектный daemon, запущенный актуальной сборкой CLI, автоматически регистрирует свою сессию в локальном каталоге пользователя. Если daemon работал до обновления Visual Intent, один раз перезапустите именно его.

Загрузите unpacked extension:

1. Откройте `chrome://extensions` и включите **Режим разработчика**.
2. Нажмите **Загрузить распакованное расширение**.
3. Выберите абсолютную папку `apps/chrome-extension/dist` этого репозитория.
4. Откройте popup Visual Intent, введите код из терминала Bridge и выберите проект назначения.
5. На обычной веб-странице нажмите **Выделить элемент на странице**, кликните по компоненту и добавьте комментарий. `Escape` отменяет выбор.
6. Снова откройте popup. Счётчик показывает готовые задачи; кнопка **Apply** передаёт их агенту выбранного проекта по обычным правилам Visual Intent.

Токены daemon не передаются расширению. Bridge хранит их в `~/.visual-intent/bridge/sessions/` с локальными правами доступа, проверяет, что daemon действительно работает на loopback-адресе, и только после этого маршрутизирует разрешённые операции. Подробности и ограничения находятся в [инструкции Chrome Extension](docs/CHROME-EXTENSION.md).

## Направление Apply в правильную проектную задачу Codex

В новом проекте исполнитель сначала имеет статус `disconnected`. При последующих запусках CLI по умолчанию использует режим `preserve` и сохраняет уже выбранный маршрут. Это сделано намеренно: запуск proxy из репозитория Visual Intent не должен заставлять задачу по разработке Visual Intent изменять любой продукт, который в этот момент показан в браузере.

Для уже существующей проектной задачи Codex после запуска proxy выполните следующую команду в терминале именно этой задачи:

```bash
node /absolute/path/to/visual-intent/apps/cli/dist/index.js attach \
  --daemon http://127.0.0.1:7310 \
  --repo /absolute/path/to/your-project
```

Плагин ищет идентификатор текущей задачи в метаданных MCP, затем в `CODEX_THREAD_ID` и `CODEX_SESSION_ID`. Если host не передал ни один из этих источников, остаётся безопасный явный параметр `threadId`; плагин не выбирает «последнюю активную» задачу по догадке. Перед подключением daemon проверяет канонический путь к репозиторию. Подключение всегда записывает текущую задачу как `controller`. Если активного автономного worker нет, эта же задача становится host-attached executor: следующий Apply получает статус `Waiting for Codex`, а задача забирает пакет через `visual_intent_list_batches` и `visual_intent_claim_batch`. Если proxy уже запущен с `isolated-worker`, подключение чата не заменяет worker и не даёт чату забирать его `queued` пакеты. ID автономной SDK-задачи хранится отдельно в `sdkWorker` и должен отличаться от ID подключённого controller: это две разные истории Codex с разной ответственностью. CLI отклоняет явный `--worker-thread`, совпавший с уже подключённым controller.

Если предпочтительнее отдельная автоматически созданная задача Codex, запустите proxy так:

```bash
pnpm vip start \
  --target http://127.0.0.1:3000 \
  --port 7310 \
  --repo /absolute/path/to/your-project \
  --project your-project \
  --executor isolated-worker
```

Первый Apply создаёт отдельную SDK-задачу, которой владеет Visual Intent, а последующие пакеты и перезапуски proxy возобновляют только её. ID сохраняется сразу после события создания SDK thread, даже если первый turn завершился ошибкой. Persisted `queued` пакеты подхватываются после перезапуска. Проектная lease `.visual-intent/worker-lease.json` не позволяет двум локальным daemon одновременно запускать один worker: живой PID блокирует второй процесс. Stale или повреждённая lease намеренно **не удаляется автоматически**, потому что после `SIGKILL` дочерний Codex-процесс теоретически ещё может редактировать репозиторий. Обычные `Ctrl+C` и `SIGTERM` отменяют активный SDK-turn, сохраняют пакет как исправимую ошибку `worker_interrupted`, оставляют частичный diff для проверки и только затем освобождают lease; автоматического отката файлов нет. После жёсткого обрыва нужно проверить процессы Codex и рабочее дерево, а затем явно разрешить recovery через `--force-recover-stale-worker`. При активном Apply для service-команды дополнительно требуется отдельный `--force`: эти флаги подтверждают разные риски. При необходимости можно явно передать ранее созданный Visual Intent worker через `--worker-thread <id>`; ID подключённой задачи Desktop сюда передавать нельзя. Явный `--executor disconnected` отключает сохранённый маршрут, а режим по умолчанию `preserve` не меняет ранее выбранного исполнителя.

Автоматическое восстановление относится только к пакету собственного SDK worker, жизненным циклом которого управляет daemon. Прерванный `in_progress` claim внешней host-attached задачи сейчас автоматически не переоткрывается: перед ручным решением нужно проверить её реальное состояние и рабочее дерево проекта.

Если агент вернул `needs_input`, панель Tasks показывает поле ответа. Продолжение сохраняет ответ в том же пакете, увеличивает `attempt` и сначала возвращает нерешённые задачи в `queued`; только после нового claim они снова становятся `in_progress`. Уже выполненные части не запускаются второй раз. Подтверждение dirty-worktree остаётся отдельным действием с точным fingerprint.

Git-baseline снимается при каждом Apply независимо от выбранной политики. По умолчанию подключённая `host-attached` задача Codex получает пакет сразу: агент видит исходное рабочее дерево, сохраняет чужие изменения и запрашивает уточнение только при реальном конфликте. В меню **«Настройки → Работа с изменениями»** можно вернуть режим **«Спрашивать подтверждение»**; тогда dirty-пакет сохраняется как `needs_input`, а подтверждение действует только для показанного fingerprint. Автономный `visual-intent-owned` worker всегда требует такое подтверждение. После выполнения `preExistingDirtyFiles` остаётся исходным контекстом, а `batchChangedFiles` и совместимое поле `changedFiles` содержат только изменения относительно baseline. Флаг `--allow-dirty` остаётся явным CLI-исключением для контролируемой локальной автоматизации.

## Локальная аналитика результата

После завершения задача переходит во вкладку **Ready** и ждёт оценки качества от 1 до 5 звёзд. Звёзды сохраняются независимо от workflow-решения и никогда не откатывают файлы. Если пользователь открывает готовую карточку и добавляет новую инструкцию в композере, Visual Intent создаёт следующий связанный раунд через `needs_revision`; исходный результат и его оценка остаются в истории.

После Apply якоря отправленных задач сразу исчезают со страницы: визуальные маркеры относятся только к редактируемому Backlog текущей итерации. Нумерация Backlog каждый раз начинается с `1`; после Apply те же локальные номера сохраняются внутри конкретного пакета во вкладках **In progress** и **Ready**, а следующая пачка снова начинается с `1`. Эти вкладки сохраняют историю по Apply-пакетам, но пакеты по умолчанию свёрнуты. При первом входе в Ready во время одного открытия панели может автоматически раскрыться только самый новый пакет с задачами без оценки; после ухода с вкладки и возврата все пакеты снова свёрнуты. Оценённые карточки показываются приглушённо, чтобы внимание оставалось на новых результатах.

В заголовке каждого готового Apply-пакета показываются фактическое время от нажатия Apply до Ready и точный общий token usage. Для пакета с несколькими задачами каждая карточка дополнительно получает оценочную долю токенов и API-эквивалентной стоимости со знаком `≈`. Сумма долей всегда сходится с измеренным пакетом, но provider не измеряет задачи по отдельности.

Агент сам классифицирует каждую задачу по нескольким категориям и масштабу. SDK worker сохраняет пять счётчиков завершённого Apply-turn: input, cached input, cache-write input, output и reasoning output. Если в пакете была одна задача, это точное измерение этой задачи. Для многозадачного пакета `heuristic-v1` детерминированно распределяет общий usage по классификации агента, масштабу и логарифмически приглушённому числу изменённых файлов; недостающие сигналы получают нейтральное значение. Это аналитическая интерполяция, а не фактические токены или строки кода отдельной задачи. `Total = Input + Output`; Cache и Reasoning являются детализацией этих величин и повторно не прибавляются. Старые пакеты рассчитываются при отображении по уже сохранённым данным и не требуют миграции истории. `direct` usage принимается только от собственного worker, а host-attached результат — только как доверенный `host-reported` receipt; при отсутствии receipt значение честно остаётся `unavailable`.

Показать локальную сводку текущего проекта:

```bash
pnpm vip metrics --repo /absolute/path/to/your-project
```

Ограничить период и выгрузить воспроизводимые данные:

```bash
pnpm vip metrics --repo /absolute/path/to/your-project --since 14d
pnpm vip metrics --repo /absolute/path/to/your-project --format json
pnpm vip metrics --repo /absolute/path/to/your-project \
  --format csv \
  --output ./visual-intent-metrics.csv
```

`--since` принимает ISO date, `Nd` или `Nh`; `--format` — `table`, `json` или `csv`. Команда читает задачи, пакеты и оценки из `.visual-intent/tasks.json`, а события и execution-записи — из `.visual-intent/usage/`. Она ничего не отправляет во внешние сервисы.

## Сброс локальной истории проекта

Чтобы начать новую измерительную выборку без старых задач, пакетов, аналитики и скриншотов, остановите активную отправку и явно укажите целевой репозиторий:

```bash
visual-intent reset --repo /absolute/path/to/your-project --yes
```

При запуске из этого monorepo используется эквивалентная команда:

```bash
pnpm vip reset --repo /absolute/path/to/your-project --yes
```

Сброс навсегда удаляет задачи, Apply-пакеты, durable execution outbox, журналы `usage/` и файлы вложений только из выбранного `<repo>/.visual-intent/`. Проектная сессия, настройки, `connection.json`, `context.md`, конфигурация запуска и файлы самого репозитория сохраняются. Команда требует `--yes` и отказывается работать, пока существует пакет в статусе `waiting_for_executor`, `queued` или `in_progress`, чтобы не стереть работу, которую агент уже получил или выполняет.

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

Параметр `--repo` даёт файловому мосту возможность проверять Git-baseline; без него операции чтения остаются совместимыми, но подтверждение dirty-worktree безопасно отклоняется.

В проекте есть два MCP-transport с разными границами:

| Возможность                                   | Универсальный stdio `visual-intent mcp`                                | Codex plugin через daemon                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Источник данных                               | Прямой `tasks.json` и журналы проекта                                  | HTTP API уже запущенного proxy                                               |
| Привязать текущую задачу и прочитать сессию   | Нет; путь задаётся через `--store` и `--repo`                          | Да: `attach_project`, `get_session`                                          |
| Задачи и Apply-пакеты                         | Список, чтение и обновление задачи                                     | Список и чтение задачи; изменение остаётся за overlay/API                    |
| События и execution-записи                    | Да                                                                     | Да                                                                           |
| Retry, ответ на `needs_input`, dirty approval | Да                                                                     | Да                                                                           |
| Claim/finish host-attached пакета             | Требует явно передать controller thread, `claimId` и `expectedAttempt` | Controller подставляется из текущей задачи; receipt claim хранится до finish |
| Пользовательская оценка и новый раунд         | Да                                                                     | Да                                                                           |
| Settings и бинарные attachments               | Нет; используются HTTP endpoints daemon                                | Нет отдельных MCP-инструментов; используются HTTP endpoints daemon           |
| Автономный SDK-пакет                          | Можно наблюдать, нельзя claim/finish                                   | Можно наблюдать, нельзя claim/finish                                         |

Универсальный файловый мост предоставляет следующие инструменты:

- `visual_intent_list_tasks` — показать все задачи или отфильтровать их по статусу;
- `visual_intent_list_batches` — показать Apply-пакеты и их статусы;
- `visual_intent_list_executions` — прочитать сохранённые execution-записи и batch usage;
- `visual_intent_list_events` — прочитать локальные события жизненного цикла;
- `visual_intent_retry_batch` — повторно запустить заблокированный или неудачный пакет после устранения причины;
- `visual_intent_approve_dirty_batch` — после явного согласия пользователя подтвердить точный dirty-baseline одного пакета;
- `visual_intent_claim_batch` — атомарно забрать один пакет из очереди и перевести его в `in_progress`;
- `visual_intent_get_task` — получить полный визуальный контекст и данные ревизии;
- `visual_intent_finish_batch` — сохранить результат реализации всего пакета;
- `visual_intent_review_task` — записать оценку и при `needs_revision` создать следующий раунд;
- `visual_intent_update_task` — изменить инструкцию либо записать статус и необязательный результат реализации.

Claim возвращает серверный receipt `batch.claim`: `id` (`claimId` для finish), номер `attempt` и ID controller, который забрал пакет. Host finish обязан вернуть тот же `claimId`, `expectedAttempt` и тот же controller; stale или чужой receipt отклоняется. Плагин Codex сохраняет receipt внутри процесса автоматически, а универсальный stdio-клиент передаёт эти поля явно.

## Локальный API

Все endpoint используют origin proxy Visual Intent:

```text
GET   /_visual-intent/api/health
GET   /_visual-intent/api/diagnostics
GET   /_visual-intent/api/session
POST  /_visual-intent/api/session/attach
GET   /_visual-intent/api/settings
PATCH /_visual-intent/api/settings
GET   /_visual-intent/api/tasks?status=ready
GET   /_visual-intent/api/tasks/:id
POST  /_visual-intent/api/tasks
PATCH /_visual-intent/api/tasks/:id
DELETE /_visual-intent/api/tasks/:id
POST  /_visual-intent/api/tasks/:id/review
PUT   /_visual-intent/api/tasks/:id/rating
POST  /_visual-intent/api/tasks/apply
POST  /_visual-intent/api/attachments?kind=<screenshot|file>&fileName=<name>
GET   /_visual-intent/api/attachments/:id
DELETE /_visual-intent/api/attachments/:id
GET   /_visual-intent/api/batches
GET   /_visual-intent/api/batches/:id
POST  /_visual-intent/api/batches/:id/claim
POST  /_visual-intent/api/batches/:id/finish
POST  /_visual-intent/api/batches/:id/retry
POST  /_visual-intent/api/batches/:id/approve-dirty
GET   /_visual-intent/api/events?since=<iso>&type=<event-type>
GET   /_visual-intent/api/executions?since=<iso>&batchId=<id>
WS    /_visual-intent/ws
```

WebSocket не повторяет внутренний тип события на верхнем уровне. Реальный wire-конверт всегда имеет форму `{"type":"tasks.changed","task":<payload>}`. Например, завершение пакета приходит как `{"type":"tasks.changed","task":{"type":"batch.completed","batch":{...},"tasks":[...]}}`; при создании обычной задачи `<payload>` может быть самой задачей. После переподключения клиент перечитывает HTTP API, потому что WebSocket — уведомление об изменении, а не надёжный журнал.

Daemon хранит всё локальное состояние проверки в `.visual-intent/` целевого репозитория: `tasks.json` содержит задачи, проектную сессию, Apply-пакеты и результаты. Receipt завершённого выполнения сначала попадает в его durable outbox и только затем идемпотентно переносится в `usage/executions.jsonl`, поэтому краткий сбой записи проекции не теряет точные токены и операции. `usage/events.jsonl` и `usage/executions.jsonl` не копируют пользовательские комментарии, DOM и изображения, но содержат агентные резюме и пути изменённых файлов; файл `connection.json` с правами `0600` содержит loopback URL, вычисленный путь к хранилищу задач и случайный токен сессии, который используется для операций изменения, доступа по WebSocket, подключения через CLI, hook и MCP-мост плагина. CLI добавляет `/.visual-intent/` в локальный Git exclude целевого репозитория. Никогда не добавляйте эти файлы в коммит.

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
  chrome-extension/ распакованное локальное Chrome Extension для внешних референсов
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
  INTERFACE-BRIEF.md
  FUTURE-MEDIA-AND-USAGE.md
  CHROME-EXTENSION.md
  NAVIGATION-READY.md
  OPERATIONS.md
```

Подробности: [продукт](docs/PRODUCT.md), [архитектура](docs/ARCHITECTURE.md), [протокол](docs/PROTOCOL.md), [платформенный roadmap](docs/PLATFORM-ROADMAP.md), [интерфейсный brief](docs/INTERFACE-BRIEF.md), [эксплуатация](docs/OPERATIONS.md), [готовность навигации](docs/NAVIGATION-READY.md) и дискуссионный документ о [будущей работе с медиа, хранением и стоимостью](docs/FUTURE-MEDIA-AND-USAGE.md).

## Лицензия

MIT
