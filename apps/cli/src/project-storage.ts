import { join } from "node:path";

export function projectTaskStorePath(repositoryRoot: string): string {
  return join(repositoryRoot, ".visual-intent", "tasks.json");
}
