import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { projectTaskStorePath } from "../src/project-storage.js";

describe("project task storage", () => {
  it("always stores feedback inside the target repository", () => {
    const repositoryRoot = join("", "workspace", "customer-project");

    expect(projectTaskStorePath(repositoryRoot)).toBe(
      join(repositoryRoot, ".visual-intent", "tasks.json"),
    );
  });
});
