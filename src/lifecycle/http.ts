import type { HttpDataEnvironment } from "../core/schemas.js";
import {
  DataLifecycleProviderError,
  type DataLifecycleFailureClassification,
  type DataLifecycleProvider,
  type DataLifecycleProviderContext,
  type DataLifecycleProviderResult,
} from "./types.js";

const defaultTimeoutMs = 30_000;

export class HttpDataLifecycleProvider implements DataLifecycleProvider {
  readonly name = "http";

  async runOperation(
    context: DataLifecycleProviderContext,
  ): Promise<DataLifecycleProviderResult> {
    if (context.environment.provider !== "http") {
      throw new Error(
        `HTTP data lifecycle provider cannot run "${context.environment.provider}" environments.`,
      );
    }

    const environment = context.environment;
    const baseUrl = environment.url ?? readRequiredEnv(environment.urlEnv, "HTTP lifecycle URL");
    const endpoint = endpointUrl(baseUrl, context.operation.function);
    const auth = authHeader(environment);
    const redactValues = auth.redactValues;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), environment.timeoutMs ?? defaultTimeoutMs);
    timeout.unref?.();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(environment.headers ?? {}),
          ...(auth.header ? { [auth.header.name]: auth.header.value } : {}),
        },
        body: JSON.stringify(context.args ?? {}),
        signal: controller.signal,
      });
      const text = await response.text();
      const result = parseHttpResult(text);

      if (!response.ok) {
        throw new DataLifecycleProviderError(
          `HTTP data lifecycle endpoint "${endpoint}" returned ${response.status} ${response.statusText}.`,
          {
            classification: classifyHttpStatus(response.status),
            result,
            httpStatus: response.status,
            redactValues,
          },
        );
      }

      return {
        result,
        httpStatus: response.status,
        redactValues,
      };
    } catch (error) {
      if (error instanceof DataLifecycleProviderError) {
        throw error;
      }
      const caught = error instanceof Error ? error : new Error(String(error));
      const aborted = caught.name === "AbortError";
      throw new DataLifecycleProviderError(
        aborted
          ? `HTTP data lifecycle endpoint "${endpoint}" timed out after ${environment.timeoutMs ?? defaultTimeoutMs}ms.`
          : `HTTP data lifecycle endpoint "${endpoint}" failed: ${caught.message}`,
        {
          classification: "execution",
          redactValues,
          cause: caught,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function endpointUrl(baseUrl: string, operationFunction: string): string {
  if (/^https?:\/\//i.test(operationFunction)) {
    return operationFunction;
  }

  if (operationFunction.startsWith("/")) {
    return new URL(operationFunction, baseUrl).toString();
  }

  const url = new URL(baseUrl);
  const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.pathname = `${basePath}${operationFunction}`.replace(/\/{2,}/g, "/");
  return url.toString();
}

function authHeader(environment: HttpDataEnvironment): {
  header?: { name: string; value: string };
  redactValues: string[];
} {
  if (!environment.authTokenEnv) {
    return { redactValues: [] };
  }

  const token = readRequiredEnv(environment.authTokenEnv, "HTTP lifecycle auth token");
  const scheme = environment.authScheme ?? "Bearer";
  const value = scheme ? `${scheme} ${token}` : token;
  return {
    header: {
      name: environment.authHeader ?? "Authorization",
      value,
    },
    redactValues: [value, token],
  };
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

function parseHttpResult(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function classifyHttpStatus(status: number): DataLifecycleFailureClassification {
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return "configuration";
  }
  return "execution";
}
