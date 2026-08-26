import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_CONTEXT_CHARACTERS = 24_000;

export function projectContextPath(repositoryRoot: string): string {
  return join(repositoryRoot, ".visual-intent", "context.md");
}

export async function ensureProjectContext(
  repositoryRoot: string,
  displayName: string,
): Promise<string> {
  const path = projectContextPath(repositoryRoot);
  await mkdir(dirname(path), { recursive: true });

  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(defaultProjectContext(displayName), "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  return path;
}

export async function readProjectContext(
  repositoryRoot: string,
): Promise<string | undefined> {
  try {
    const content = (await readFile(projectContextPath(repositoryRoot), "utf8"))
      .trim()
      .slice(0, MAX_CONTEXT_CHARACTERS);
    return content || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function captureProjectContext(
  repositoryRoot: string,
): Promise<{ revision: number; content: string } | undefined> {
  const content = await readProjectContext(repositoryRoot);
  if (!content) return undefined;

  const revision =
    Number.parseInt(
      createHash("sha256").update(content).digest("hex").slice(0, 12),
      16,
    ) + 1;
  return { revision, content };
}

function defaultProjectContext(displayName: string): string {
  return `# Контекст проекта ${displayName}

Этот локальный файл читает автономный Visual Intent worker перед каждым Apply.
Храните здесь только устойчивые решения, которые должны пережить отдельные чаты.

## Цель продукта

<!-- Кратко: для кого продукт и какую задачу решает. -->

## Архитектурные и продуктовые ограничения

<!-- Например: границы модулей, запрещённые изменения, источник истины. -->

## Дизайн и связанные материалы

<!-- Например: ссылка на Figma, токены, правила интерфейса. -->

## Проверка изменений

<!-- Команды lint, tests, build и важные ручные сценарии. -->
`;
}
