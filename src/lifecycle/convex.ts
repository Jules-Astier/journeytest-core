import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConvexDataEnvironment } from "../core/schemas.js";
import type {
  DataLifecycleProvider,
  DataLifecycleProviderContext,
  DataLifecycleProviderResult,
} from "./types.js";
import { DataLifecycleProviderError } from "./types.js";

const execFileAsync = promisify(execFile);

interface ConvexHttpClientLike {
  query(reference: unknown, args?: unknown): Promise<unknown>;
  mutation(reference: unknown, args?: unknown): Promise<unknown>;
  action(reference: unknown, args?: unknown): Promise<unknown>;
  setAuth?(token: string): void;
}

export class ConvexDataLifecycleProvider implements DataLifecycleProvider {
  readonly name = "convex";

  async runOperation(
    context: DataLifecycleProviderContext,
  ): Promise<DataLifecycleProviderResult> {
    if (context.environment.provider !== "convex") {
      throw new Error(
        `Convex data lifecycle provider cannot run "${context.environment.provider}" environments.`,
      );
    }

    if (context.environment.transport === "http") {
      return this.runHttp(context.environment, context);
    }

    return this.runCli(context.environment, context);
  }

  private async runHttp(
    environment: ConvexDataEnvironment,
    context: DataLifecycleProviderContext,
  ): Promise<DataLifecycleProviderResult> {
    const url = environment.url ?? readRequiredEnv(environment.urlEnv, "Convex URL");
    const authToken = environment.authTokenEnv
      ? readRequiredEnv(environment.authTokenEnv, "Convex auth token")
      : undefined;
    const redactValues = authToken ? [authToken] : [];
    const browserModule = "convex/browser";
    const serverModule = "convex/server";
    const [{ ConvexHttpClient }, { makeFunctionReference }] = await Promise.all([
      import(browserModule) as Promise<{
        ConvexHttpClient: new (url: string) => ConvexHttpClientLike;
      }>,
      import(serverModule) as Promise<{
        makeFunctionReference: (name: string) => unknown;
      }>,
    ]).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not load the optional "convex" package for HTTP data lifecycle operations: ${message}`,
      );
    });

    const client = new ConvexHttpClient(url);
    if (authToken && client.setAuth) {
      client.setAuth(authToken);
    }

    try {
      const reference = makeFunctionReference(context.operation.function);
      const result =
        context.operation.kind === "query"
          ? await client.query(reference, context.args)
          : context.operation.kind === "action"
            ? await client.action(reference, context.args)
            : await client.mutation(reference, context.args);

      return { result, redactValues };
    } catch (error) {
      const caught = error instanceof Error ? error : new Error(String(error));
      throw new DataLifecycleProviderError(
        `Convex HTTP data lifecycle operation "${context.operation.function}" failed: ${caught.message}`,
        {
          classification: "execution",
          redactValues,
          cause: caught,
        },
      );
    }
  }

  private async runCli(
    environment: ConvexDataEnvironment,
    context: DataLifecycleProviderContext,
  ): Promise<DataLifecycleProviderResult> {
    const args = [
      "convex",
      "run",
      context.operation.function,
      JSON.stringify(context.args ?? {}),
      ...(environment.prod ? ["--prod"] : []),
      ...(environment.deployment ? ["--deployment", environment.deployment] : []),
      ...(environment.push ? ["--push"] : []),
    ];

    const { stdout, stderr } = await execFileAsync("npx", args, {
      cwd: environment.projectDir ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      result: parseConvexCliResult(stdout),
      stdout,
      stderr,
    };
  }
}

function readRequiredEnv(name: string | undefined, label: string): string {
  if (!name) {
    throw new Error(`${label} environment variable name was not configured.`);
  }

  const value = process.env[name];
  if (!value) {
    throw new Error(`${label} environment variable "${name}" is not set.`);
  }
  return value;
}

function parseConvexCliResult(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue looking for the last JSON line printed by Convex.
      }
    }
  }

  return trimmed;
}
