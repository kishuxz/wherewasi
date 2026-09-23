import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { listHandoffTasks, loadHandoff } from "./handoff.js";

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
        const tasks = await listHandoffTasks(repository ?? defaultDirectory);
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
        const handoff = await loadHandoff(repository ?? defaultDirectory, tag);
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

  return server;
}

export async function runMcp(directory: string): Promise<void> {
  const cwd = path.resolve(directory);
  await serveStdio(() => createHandoffServer(cwd));
}
