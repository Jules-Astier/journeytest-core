import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBrowserDriver } from "../src/drivers/agent-browser/index.js";

const hasAgentBrowser = (() => {
  try {
    execFileSync("agent-browser", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.close();
    await once(server, "close");
    server = undefined;
  }
});

describe.skipIf(!hasAgentBrowser)(
  "AgentBrowserDriver UI change observation",
  () => {
    it("captures transient button and status changes through the real browser CLI", async () => {
      const baseUrl = await startFixtureServer();
      const driver = new AgentBrowserDriver();
      await driver.start({
        runId: "ui-change-integration",
        runDir: "/tmp/journeytest-agent-browser-ui-change",
        baseUrl,
        allowedOrigins: [baseUrl],
        sessionName: `journeytest-ui-change-${Date.now()}`,
      });

      try {
        await driver.open(baseUrl);
        await driver.startUiChangeObservation({
          timeoutMs: 1_500,
          quietMs: 200,
        });
        await driver.click("#save");
        await new Promise((resolve) => setTimeout(resolve, 700));
        const observation = (await driver.stopUiChangeObservation()).details;

        expect(
          observation?.changes.some((change) => change.text === "Saving"),
        ).toBe(true);
        expect(
          observation?.changes.some((change) => change.text === "Saved"),
        ).toBe(true);
        expect(
          observation?.changes.some(
            (change) =>
              change.role === "status" && change.text === "Saved successfully",
          ),
        ).toBe(true);
      } finally {
        await driver.close();
      }
    });
  },
);

async function startFixtureServer(): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html>
  <body>
    <button id="save">Save</button>
    <script>
      document.querySelector("#save").addEventListener("click", () => {
        const button = document.querySelector("#save");
        button.textContent = "Saving";
        setTimeout(() => {
          button.textContent = "Saved";
          const status = document.createElement("div");
          status.setAttribute("role", "status");
          status.textContent = "Saved successfully";
          document.body.appendChild(status);
          setTimeout(() => status.remove(), 500);
        }, 100);
      });
    </script>
  </body>
</html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start fixture server.");
  }
  return `http://127.0.0.1:${address.port}`;
}
