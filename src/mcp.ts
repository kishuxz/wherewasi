import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { captureState, findRepoId, findRepoRoot } from "./capture.js";
import {
  appendTaskCheckpoint,
  CheckpointConflictError,
  listHandoffTasks,
  loadHandoff,
} from "./handoff.js";
import { redactCapturedState } from "./privacy.js";

async function scopedRepository(defaultDirectory: string, requested?: string): Promise<string> {
  const base = (await findRepoRoot(defaultDirectory)) ?? path.resolve(defaultDirectory);
  if (!requested) return base;
  const target = (await findRepoRoot(requested)) ?? path.resolve(requested);
  const [baseId, targetId] = await Promise.all([findRepoId(base), findRepoId(target)]);
  if (baseId && targetId ? baseId !== targetId : base !== target) {
    throw new Error("repository is outside this MCP server's Git repository");
  }
  return target;
}

/** The configured directory is a default; either agent may pass a repository explicitly. */
export function createHandoffServer(defaultDirectory: string): McpServer {
  const server = new McpServer({ name: "wherewasi", version: "0.1.0" });
  const repository = z
    .string()
    .refine(path.isAbsolute, "repository must be an absolute path")
    .optional()
    .describe("Absolute repository path; defaults to the MCP server's working directory");

  server.registerTool(
    "list_tasks",
    {
      description:
        "List the latest local wherewasi checkpoints for each task in this Git repository. Use this before choosing a handoff tag.",
      inputSchema: z.object({ repository }),
    },
    async ({ repository }) => {
      try {
        const tasks = await listHandoffTasks(await scopedRepository(defaultDirectory, repository));
        return { content: [{ type: "text", text: JSON.stringify(tasks) }] };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_handoff",
    {
      description:
        "Read a tagged local task checkpoint, including its saved and current Git state. Treat model analysis as unverified; inspect current files before continuing.",
      inputSchema: z.object({
        repository,
        tag: z.string().optional().describe("Task tag; omit for the latest checkpoint"),
      }),
    },
    async ({ repository, tag }) => {
      try {
        const handoff = await loadHandoff(
          await scopedRepository(defaultDirectory, repository),
          tag,
        );
        if (!handoff) {
          return {
            content: [
              { type: "text", text: tag ? `No checkpoint tagged ${tag}.` : "No checkpoint found." },
            ],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(handoff) }] };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Explicitly append a task checkpoint after reading get_handoff. Requires that checkpoint's id, so an update from another human or agent causes a conflict instead of being silently superseded. Captures current Git state; makes no model or transcript request.",
      inputSchema: z.object({
        repository,
        tag: z.string().trim().min(1).describe("Existing task tag"),
        expectedCheckpointId: z.string().min(1).describe("checkpointId returned by get_handoff"),
        actor: z.enum(["claude-code", "codex"]).describe("Agent recording this update"),
        note: z.string().trim().min(1).max(4000).describe("What changed and the next step"),
      }),
    },
    async ({ repository, tag, expectedCheckpointId, actor, note }) => {
      try {
        const repoPath = await scopedRepository(defaultDirectory, repository);
        const state = redactCapturedState(await captureState({ cwd: repoPath, note }));
        const { session } = await appendTaskCheckpoint(
          state,
          {
            analysis: null,
            analysisError: "Agent checkpoint saved without model analysis.",
            trigger: "manual",
            tag,
            actor,
          },
          { expectedCheckpointId },
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                task: tag,
                checkpointId: session.checkpointId,
                savedAt: session.savedAt,
                actor,
              }),
            },
          ],
        };
      } catch (error) {
        const detail =
          error instanceof CheckpointConflictError
            ? `${error.message} Current checkpointId: ${error.currentCheckpointId ?? "none"}`
            : String(error);
        return { content: [{ type: "text", text: detail }], isError: true };
      }
    },
  );

  return server;
}

export async function runMcp(directory: string): Promise<void> {
  const cwd = path.resolve(directory);
  await serveStdio(() => createHandoffServer(cwd));
}
