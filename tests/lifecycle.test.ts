import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataLifecycleConfigSchema } from "../src/core/schemas.js";
import {
  AppLifecycleController,
  applyAppTargetOverride,
  DataLifecycleBlockedError,
  DataLifecycleController,
  HttpDataLifecycleProvider,
  ScriptDataLifecycleProvider,
} from "../src/lifecycle/index.js";

describe("data lifecycle providers", () => {
  it("parses Convex, script, and HTTP data environments", () => {
    const config = DataLifecycleConfigSchema.parse({
      dataEnvironments: {
        "local-convex": {
          provider: "convex",
          transport: "http",
          urlEnv: "CONVEX_URL",
        },
        "local-script": {
          provider: "script",
          command: process.execPath,
          commandArgs: ["scripts/lifecycle.mjs"],
          capabilities: {
            internalFunctions: true,
          },
        },
        "local-http": {
          provider: "http",
          url: "http://127.0.0.1:3000/test/lifecycle",
          authHeader: "X-JourneyTest-Token",
          authTokenEnv: "JOURNEYTEST_TOKEN",
        },
      },
    });

    expect(config.dataEnvironments["local-convex"]?.provider).toBe("convex");
    expect(config.dataEnvironments["local-script"]).toMatchObject({
      provider: "script",
      passArgs: "json-argv",
    });
    expect(config.dataEnvironments["local-http"]).toMatchObject({
      provider: "http",
      authScheme: "Bearer",
    });
    expect(() =>
      DataLifecycleConfigSchema.parse({
        dataEnvironments: {
          broken: {
            provider: "http",
          },
        },
      }),
    ).toThrow(/HTTP data lifecycle environments require url or urlEnv/);
  });

  it("runs script operations with templated args and captures output metadata", async () => {
    const restoreEnv = setTemporaryEnv("JT_SCRIPT_SECRET", "script-secret-value");
    const tempDir = await mkdtemp(join(tmpdir(), "journeytest-script-"));
    const scriptPath = join(tempDir, "lifecycle.mjs");
    await writeFile(
      scriptPath,
      [
        "const operation = process.argv[2];",
        'const args = JSON.parse(process.argv[3] ?? "{}");',
        'process.stderr.write(`stderr:${operation}\\n`);',
        'console.log(`stdout:${operation}`);',
        "console.log(JSON.stringify({",
        "  fixture: { namespace: args.namespace, token: args.token },",
        '  checks: [{ id: "script-ok", status: "pass", message: "Script fixture ready." }]',
        "}));",
      ].join("\n"),
      "utf8",
    );

    try {
      const config = DataLifecycleConfigSchema.parse({
        dataEnvironments: {
          "local-script": {
            provider: "script",
            command: process.execPath,
            commandArgs: [scriptPath],
          },
        },
      });
      const controller = new DataLifecycleController({
        definition: {
          environment: "local-script",
          setup: [{
            id: "setup-script",
            function: "setup",
            args: {
              namespace: "$context.namespace",
              token: "$env.JT_SCRIPT_SECRET",
            },
            manifestPath: "$.fixture",
          }],
        },
        environments: config.dataEnvironments,
        provider: new ScriptDataLifecycleProvider(),
        scope: "journey",
        runId: "script-run",
        runDir: join(tempDir, "artifacts"),
      });

      await controller.runSetupAndPreflight();
      controller.finish();

      const setup = controller.result.setup[0];
      expect(setup).toMatchObject({
        provider: "script",
        function: "setup",
        status: "passed",
        exitCode: 0,
      });
      expect(setup?.stdout).toContain("stdout:setup");
      expect(setup?.stderr).toContain("stderr:setup");
      expect(setup?.args).toMatchObject({
        namespace: controller.result.namespace,
        token: "[redacted]",
      });
      expect(controller.result.manifest).toMatchObject({
        namespace: controller.result.namespace,
        token: "[redacted]",
      });
    } finally {
      restoreEnv();
    }
  });

  it("posts HTTP operations with auth headers and redacts env tokens", async () => {
    const restoreEnv = setTemporaryEnv("JT_HTTP_TOKEN", "http-secret-value");
    const requests: Array<{ url?: string; auth?: string; body: unknown }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsedBody = body ? JSON.parse(body) : {};
        const auth = request.headers["x-journeytest-token"];
        requests.push({
          url: request.url,
          auth: Array.isArray(auth) ? auth.join(",") : auth,
          body: parsedBody,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            seen: auth,
            manifest: { seen: auth },
            body: parsedBody,
            checks: [{ id: "http-ok", status: "pass" }],
          }),
        );
      });
    });

    try {
      const baseUrl = await listen(server);
      const tempDir = await mkdtemp(join(tmpdir(), "journeytest-http-"));
      const config = DataLifecycleConfigSchema.parse({
        dataEnvironments: {
          "local-http": {
            provider: "http",
            url: `${baseUrl}/test/lifecycle`,
            authHeader: "X-JourneyTest-Token",
            authTokenEnv: "JT_HTTP_TOKEN",
          },
        },
      });
      const controller = new DataLifecycleController({
        definition: {
          environment: "local-http",
          setup: [{
            id: "setup-http",
            function: "setup",
            args: {
              namespace: "$context.namespace",
            },
            manifestPath: "$.manifest",
          }],
        },
        environments: config.dataEnvironments,
        provider: new HttpDataLifecycleProvider(),
        scope: "journey",
        runId: "http-run",
        runDir: join(tempDir, "artifacts"),
      });

      await controller.runSetupAndPreflight();
      controller.finish();

      const setup = controller.result.setup[0];
      expect(requests).toEqual([
        {
          url: "/test/lifecycle/setup",
          auth: "Bearer http-secret-value",
          body: { namespace: controller.result.namespace },
        },
      ]);
      expect(setup).toMatchObject({
        provider: "http",
        httpStatus: 200,
        status: "passed",
      });
      expect(JSON.stringify(setup)).not.toContain("http-secret-value");
      expect(JSON.stringify(controller.result.manifest)).not.toContain("http-secret-value");
      expect(setup?.result).toMatchObject({
        seen: "[redacted]",
        manifest: { seen: "[redacted]" },
      });
    } finally {
      restoreEnv();
      await closeServer(server);
    }
  });

  it("classifies script process failures as execution failures", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "journeytest-script-fail-"));
    const scriptPath = join(tempDir, "fail.mjs");
    await writeFile(
      scriptPath,
      [
        'process.stdout.write("script stdout\\n");',
        'process.stderr.write("script stderr\\n");',
        "process.exit(7);",
      ].join("\n"),
      "utf8",
    );
    const config = DataLifecycleConfigSchema.parse({
      dataEnvironments: {
        "local-script": {
          provider: "script",
          command: process.execPath,
          commandArgs: [scriptPath],
        },
      },
    });
    const controller = new DataLifecycleController({
      definition: {
        environment: "local-script",
        setup: [{
          id: "fail-script",
          function: "fail",
        }],
      },
      environments: config.dataEnvironments,
      provider: new ScriptDataLifecycleProvider(),
      scope: "journey",
      runId: "script-fail-run",
      runDir: join(tempDir, "artifacts"),
    });

    await expect(controller.runSetupAndPreflight()).rejects.toBeInstanceOf(
      DataLifecycleBlockedError,
    );
    expect(controller.result.setup[0]).toMatchObject({
      status: "failed",
      stdout: "script stdout\n",
      stderr: "script stderr\n",
      exitCode: 7,
      error: {
        classification: "execution",
      },
    });
  });

  it("classifies failing lifecycle checks as assertion failures", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          checks: [{ id: "db-state", status: "fail", message: "Missing submitted row." }],
        }),
      );
    });

    try {
      const baseUrl = await listen(server);
      const tempDir = await mkdtemp(join(tmpdir(), "journeytest-http-assert-"));
      const config = DataLifecycleConfigSchema.parse({
        dataEnvironments: {
          "local-http": {
            provider: "http",
            url: baseUrl,
          },
        },
      });
      const controller = new DataLifecycleController({
        definition: {
          environment: "local-http",
          preflight: [
            {
              id: "assert-db",
              kind: "query",
              function: "assert-db",
            },
          ],
        },
        environments: config.dataEnvironments,
        provider: new HttpDataLifecycleProvider(),
        scope: "journey",
        runId: "http-assert-run",
        runDir: join(tempDir, "artifacts"),
      });

      await expect(controller.runSetupAndPreflight()).rejects.toBeInstanceOf(
        DataLifecycleBlockedError,
      );
      expect(controller.result.preflight[0]).toMatchObject({
        status: "failed",
        httpStatus: 200,
        error: {
          classification: "assertion",
          message: "Data lifecycle checks failed: db-state: Missing submitted row.",
        },
      });
    } finally {
      await closeServer(server);
    }
  });
});

describe("app lifecycle scripts", () => {
  it("allocates requested ports, resolves app targets, and runs cleanup", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "journeytest-app-lifecycle-"));
    const cleanupPath = join(tempDir, "cleanup.json");
    const cleanupScript = join(tempDir, "cleanup.mjs");
    await writeFile(
      cleanupScript,
      [
        'import { writeFile } from "node:fs/promises";',
        'const context = JSON.parse(process.argv[2] ?? "{}");',
        `await writeFile(${JSON.stringify(cleanupPath)}, JSON.stringify({ phase: context.phase, port: context.ports.frontend }));`,
      ].join("\n"),
      "utf8",
    );

    const config = DataLifecycleConfigSchema.parse({
      dataEnvironments: {},
      appLifecycle: {
        ports: {
          frontend: {},
        },
        app: {
          baseUrl: "http://$hosts.frontend:$ports.frontend",
          allowedOrigins: ["http://$hosts.frontend:$ports.frontend"],
        },
        start: {
          command: process.execPath,
          commandArgs: [
            "-e",
            "console.log(JSON.stringify({ app: { name: 'Dynamic App' } }))",
          ],
        },
        cleanup: {
          command: process.execPath,
          commandArgs: [cleanupScript],
        },
      },
    });
    const controller = await AppLifecycleController.create({
      config: config.appLifecycle!,
      suiteRunId: "suite-app",
      runDir: join(tempDir, "artifacts"),
    });

    await controller.runStart();
    await controller.runCleanup();

    expect(controller.appTarget?.name).toBe("Dynamic App");
    expect(controller.appTarget?.baseUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
    expect(controller.result.start?.status).toBe("passed");
    expect(controller.result.cleanup?.status).toBe("passed");
    expect(JSON.parse(await readFile(cleanupPath, "utf8"))).toMatchObject({
      phase: "cleanup",
      port: controller.result.context.ports.frontend,
    });

    const journey = applyAppTargetOverride(
      {
        app: {
          name: "Original",
          baseUrl: "http://127.0.0.1:3000",
          allowedOrigins: ["http://127.0.0.1:3000"],
        },
      },
      controller.appTarget,
    );
    expect(journey.app.baseUrl).toBe(controller.appTarget?.baseUrl);
  });
});

function setTemporaryEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
