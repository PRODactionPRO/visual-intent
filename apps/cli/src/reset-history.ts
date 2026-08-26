import { lstat, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  FileTaskStore,
  type ResetHistoryResult,
} from "@visual-intent/file-store";

import { projectTaskStorePath } from "./project-storage.js";

export interface ResetProjectHistoryInput {
  repo: string;
  confirmed: boolean;
}

export interface ResetProjectHistoryResult extends ResetHistoryResult {
  repositoryRoot: string;
}

export async function resetProjectHistory(
  input: ResetProjectHistoryInput,
): Promise<ResetProjectHistoryResult> {
  if (!input.confirmed) {
    throw new Error(
      "History reset requires --yes because it permanently deletes local Visual Intent tasks, batches, analytics, and attachments",
    );
  }

  const repositoryRoot = await realpath(resolve(input.repo));
  const repositoryDetails = await lstat(repositoryRoot);
  if (!repositoryDetails.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repositoryRoot}`);
  }

  const storageDirectory = join(repositoryRoot, ".visual-intent");
  const storageDetails = await lstat(storageDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (storageDetails?.isSymbolicLink()) {
    throw new Error(
      `Refusing to reset Visual Intent history through a symlink: ${storageDirectory}`,
    );
  }
  if (!storageDetails) {
    return emptyResult(repositoryRoot);
  }
  if (!storageDetails.isDirectory()) {
    throw new Error(
      `Visual Intent storage path is not a directory: ${storageDirectory}`,
    );
  }

  const store = new FileTaskStore(projectTaskStorePath(repositoryRoot), {
    root: repositoryRoot,
    name: basename(repositoryRoot),
  });
  const session = await store.getSession();
  if (session && session.repository.root !== repositoryRoot) {
    throw new Error(
      `Visual Intent store belongs to ${session.repository.root}, not ${repositoryRoot}`,
    );
  }
  return {
    repositoryRoot,
    ...(await store.resetHistory()),
  };
}

function emptyResult(repositoryRoot: string): ResetProjectHistoryResult {
  return {
    repositoryRoot,
    tasks: 0,
    batches: 0,
    executionOutbox: 0,
    events: 0,
    executions: 0,
    attachmentFiles: 0,
  };
}
