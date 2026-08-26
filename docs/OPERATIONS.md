# Эксплуатация локального Visual Intent

Этот документ описывает устойчивый локальный контур без облачного backend.
Visual Intent управляет только своим proxy. Dev server целевого проекта остаётся
под управлением самого проекта: `pnpm dev`, Docker Compose или отдельный
проектный LaunchAgent.

## Быстрый запуск и диагностика

Foreground-запуск подходит для короткой проверки из обычного терминала:

```bash
pnpm vip start \
  --target http://127.0.0.1:3000 \
  --port 7310 \
  --repo /absolute/path/to/project \
  --executor isolated-worker
```

Такой процесс завершится вместе с терминалом. Для рабочей сессии на macOS
установите отдельный пользовательский LaunchAgent:

```bash
pnpm vip service install \
  --target http://127.0.0.1:3000 \
  --port 7310 \
  --repo /absolute/path/to/project \
  --project project-key \
  --name "Название проекта" \
  --executor isolated-worker
```

Конфигурация сохраняется в `<repo>/.visual-intent/service.json` с правами
`0600`. LaunchAgent получает стабильное имя, абсолютные пути к Node.js и CLI,
рабочую папку проекта, безопасный `PATH` и постоянные файлы логов. Shell-строка
или команда запуска target-приложения в конфигурацию не попадает.

Короткая project-lock не позволяет командам `install`, `start`, `stop`,
`restart` и `uninstall` одновременно менять один LaunchAgent. `service.json`
атомарно записывается до публикации plist и bootstrap, поэтому внезапное
закрытие терминала не оставляет неадресуемый job. После штатной ошибки установка
восстанавливает прежний конфиг или удаляет новый, а после неудачного `bootout`
сохраняет и plist, и конфиг для последующих `status`, `stop`, `logs` и
`uninstall`.

Команда не сообщает ложное «запущено» только по PID. Успешный старт означает,
что LaunchAgent работает и health-ответ подтверждает тот же канонический
репозиторий, экземпляр daemon, сессию и ожидаемый URL proxy. Если health не
появился, установка откатывается. Если аварийная команда остановки LaunchAgent
сама завершилась ошибкой, plist и конфиг сохраняются, чтобы не оставить
невидимый неуправляемый процесс; сообщение показывает точные команды и пути к
логам.

Управление сервисом:

```bash
pnpm vip service status --repo /absolute/path/to/project
pnpm vip service restart --repo /absolute/path/to/project
pnpm vip service stop --repo /absolute/path/to/project
pnpm vip service start --repo /absolute/path/to/project
pnpm vip service logs --repo /absolute/path/to/project
pnpm vip service uninstall --repo /absolute/path/to/project
```

`install`, `stop`, `restart`, `uninstall` и аварийный `start` уже загруженного,
но остановленного процесса отказываются вмешиваться при активном Apply.
Параметр `--force` поддерживается этими изменяющими lifecycle командами только
для осознанного recovery после проверки логов и состояния проекта. Даже после
смены executor store выдаёт не больше одного `in_progress` claim на репозиторий,
поэтому новый writer не начнёт работу параллельно уже выполняющему пакет.
`uninstall` удаляет только LaunchAgent, но сохраняет
connection-файл, задачи, вложения, аналитику, настройки, `context.md`,
`service.json`, логи и исходники проекта. Сохранённое подключение может стать
stale; `doctor` явно это покажет, не рискуя удалить подключение другого живого
daemon.

Foreground CLI и LaunchAgent нельзя запускать одновременно для одного
репозитория. Проектная `.visual-intent/daemon-lease.json` создаётся атомарно и
живёт до остановки proxy; отдельная проверка `connection.json` обнаруживает и
старые daemon, созданные до появления lease. Кроме того, plist одного проекта
не может зарезервировать второй label или порт, а один proxy-порт не может быть
зарезервирован двумя проектами.

## Аварийное восстановление SDK worker

После обычного `Ctrl+C` или `SIGTERM` Visual Intent отменяет SDK-turn, сохраняет
частичные изменения как `worker_interrupted` и освобождает worker lease. После
`SIGKILL`, падения компьютера или повреждения lease daemon не может доказать,
что дочерний Codex-процесс уже прекратил запись. Поэтому автоматическое удаление
`.visual-intent/worker-lease.json` запрещено.

Сначала проверьте список процессов Codex, `git status`, diff и логи Visual
Intent. Если старого исполнителя точно нет, разрешите recovery явно:

```bash
pnpm vip start \
  --target http://127.0.0.1:3000 \
  --repo /absolute/path/to/project \
  --executor isolated-worker \
  --force-recover-stale-worker
```

Для установленного сервиса:

```bash
pnpm vip service start \
  --repo /absolute/path/to/project \
  --force-recover-stale-worker

# либо для уже загруженного сервиса
pnpm vip service restart \
  --repo /absolute/path/to/project \
  --force-recover-stale-worker
```

`--force-recover-stale-worker` удаляет только подтверждённо stale worker lease.
Он не означает согласие вмешиваться в активный Apply. Если сохранённый пакет всё
ещё активен, service-команда потребует оба независимых подтверждения:
`--force --force-recover-stale-worker`.

## Команда doctor

Проверка ничего не меняет:

```bash
pnpm vip doctor --repo /absolute/path/to/project
pnpm vip doctor --repo /absolute/path/to/project --format json
```

`doctor` сверяет канонический Git-корень, локальный exclude, connection-файл,
экземпляр daemon, проектную сессию, executor, доступность proxy и target. Для
Next.js он также ищет `allowedDevOrigins`. Команда показывает готовые рецепты
для Biome, ESLint и Prettier, но не редактирует конфигурацию потребителя.

Коды завершения: `0` — всё в порядке, `1` — есть предупреждения, `2` — есть
ошибка. С `--strict` предупреждения также дают код `2`.

## Runtime-файлы и проверки проекта

Visual Intent добавляет `/.visual-intent/` только в локальный
`.git/info/exclude`. Линтеры Git exclude не обязаны учитывать, поэтому проекту
может понадобиться один из следующих ignore:

- Biome: добавить `!.visual-intent` в соответствующий `files.includes`;
- ESLint: добавить глобальный ignore `.visual-intent/**`;
- Prettier: добавить `.visual-intent/` в `.prettierignore`.

Это сознательное local-first решение: состояние остаётся рядом с конкретным
проектом и не смешивается между репозиториями. `doctor` обнаруживает конфликт с
проверками, а не переносит данные в глобальную скрытую папку.

## Готовность после навигации

Автоматизированной проверке не следует ждать `networkidle`: dev server может
держать HMR/WebSocket открытым постоянно. Используйте постоянный marker и
событие Visual Intent, описанные в [NAVIGATION-READY.md](NAVIGATION-READY.md).

## Диагностические данные

Защищённый endpoint `GET /_visual-intent/api/diagnostics` доступен только с
токеном текущей локальной сессии. Он хранит в памяти не более 50 последних
фактов proxy: время, тип, pathname, HTTP-статус и безопасный код ошибки. Query,
headers, cookies, body и текст исключения не записываются. После перезапуска
daemon этот краткий буфер очищается.
