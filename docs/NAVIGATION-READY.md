# Контракт готовности страницы для автоматизации

Visual Intent публикует собственный признак готовности. Он нужен тестам и
coding-агентам, чтобы не ждать условный `networkidle`, который часто никогда не
наступает у dev server с открытым HMR/WebSocket.

## Маркер состояния

Сразу после создания overlay его host получает атрибут:

```html
<div
  id="visual-intent-overlay-root"
  data-visual-intent-bootstrap="booting"
></div>
```

После первого чтения задач и runtime-контекста значение один раз становится
терминальным:

- `ready` — успешно прочитаны задачи, сессия, пакеты и выполнения;
- `degraded` — хотя бы один из этих запросов завершился ошибкой.

Bootstrap ограничен восемью секундами. Если API завис и не завершил запрос,
маркер всё равно становится `degraded`, поэтому автоматизация не повторяет
исходную проблему бесконечного ожидания.

Терминальное значение сохраняется на DOM-узле. Последующие WebSocket-обновления
перечитывают данные, но не стирают исходный результат bootstrap. Поэтому тест,
который подписался слишком поздно на событие, всегда может прочитать маркер.

## Событие

После терминального перехода `document` получает одно событие
`visual-intent:navigation-ready`:

```ts
type VisualIntentNavigationReadyDetail = {
  version: "v1";
  status: "ready" | "degraded";
  daemonInstanceId: string | null;
  sessionId: string | null;
  url: string;
  readyAt: string;
};
```

`daemonInstanceId` позволяет отличить новый daemon от устаревшего подключения,
а `sessionId` — проверить, что proxy обслуживает ожидаемый проект. При
`degraded` идентификатор сессии может быть `null`, потому что runtime API не
ответил.

## Рекомендуемое ожидание в Playwright

Сначала достаточно дождаться появления терминального маркера:

```ts
await page.goto("http://127.0.0.1:7310/", {
  waitUntil: "domcontentloaded",
});

await page.waitForFunction(() => {
  const host = document.querySelector("#visual-intent-overlay-root");
  const status = host?.getAttribute("data-visual-intent-bootstrap");
  return status === "ready" || status === "degraded";
});

const status = await page
  .locator("#visual-intent-overlay-root")
  .getAttribute("data-visual-intent-bootstrap");

if (status !== "ready") {
  throw new Error(`Visual Intent bootstrap завершился как ${status}`);
}
```

Это контракт готовности API самого overlay. Он **не** утверждает, что host
приложение закончило все фоновые запросы, анимации или бизнес-загрузку. Для
таких условий проект добавляет собственные признаки. Открытые HMR/WebSocket
соединения не являются ошибкой и не участвуют в вычислении статуса.

## Ручная проверка

Запустите обычную демонстрацию и откройте fixture через proxy:

```bash
pnpm demo
```

```text
http://127.0.0.1:7310/navigation-ready-demo.html
```

Страница специально подключает Vite HMR. Несмотря на открытый WebSocket,
индикатор должен перейти из `booting` в `ready`. При недоступном runtime API он
должен завершиться как `degraded`, а не бесконечно оставаться в `booting`.
