import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const MAIN = `const electron = require("electron");
function registerSnapshot(deps) {
  deps.ipcMain.on("app:snapshot", (event) => { event.returnValue = 1; });
}
registerSnapshot({ ipcMain: electron.ipcMain, store: {} });
function transport(ipc, facts) {
  return { handle: (channel, run) => ipc.handle(channel, (event, arg) => run(facts(event), arg)) };
}
transport(electron.ipcMain, () => ({}));
transport(options.ipcMain, () => ({}));
function consent(request, Window) {
  return new Window({ webPreferences: { nodeIntegration: false, contextIsolation: true } });
}
consent({}, injected.BrowserWindow ?? electron.BrowserWindow);
throw new Error("must not execute main");
`;

const PRELOAD = `const { contextBridge, ipcRenderer } = require("electron");
function expose(bridge) { bridge.exposeInMainWorld("reliability", { report: 1 }); }
expose(contextBridge);
ipcRenderer.sendSync("app:snapshot");
const update = { check() {}, quitAndInstall: () => 0 };
const desktop = { openExternal() {}, update, theme: { get: 1 }, ...(cookies == null ? {} : { chromeCookies: cookies }) };
contextBridge.exposeInMainWorld("desktop", desktop);
const patched = { ready: 1 };
patched.late = 2;
contextBridge.exposeInMainWorld("patched", patched);
throw new Error("must not execute preload");
`;

type Graph = z.infer<typeof javascriptApplicationAnalysisResultSchema>["graph"];

const located = (graph: Graph, kind: string, line: number) =>
  graph.nodes.find(
    (node) =>
      node.kind === kind &&
      node.observations.some(({ evidence: { location } }) =>
        location.available && location.value.kind === "source-range"
          ? location.value.start.line === line
          : false,
      ),
  );

cliTest.for(["CLI", "stdio MCP"] as const)(
  "maps Electron APIs reached through wrappers through %s without executing source",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-electron-wrappers-");
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({ main: "main.cjs" }),
      ),
      writeFile(join(root, "main.cjs"), MAIN),
      writeFile(join(root, "preload.cjs"), PRELOAD),
    ]);

    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: ["analyze-javascript-application", root, "--format", "json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(response.exitCode, response.stderr).toBe(0);
      document = response.json;
    } else {
      const { call } = await connectLocalToolsMcp();
      const response = await call("analyze_javascript_application", {
        input_path: root,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      document = response.structuredContent;
    }
    const { graph, summary } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(document).normalized_result;

    expect(summary).toMatchObject({
      browser_windows: 1,
      context_bridge_apis: 3,
      ipc: { main_handlers: 2, paired_renderer_transmissions: 1 },
    });
    const snapshot = located(graph, "ipc-handler", 3);
    expect(snapshot?.observations[0]?.properties).toMatchObject({
      channel: "app:snapshot",
      electron_identity: {
        basis: "wrapper-parameter",
        function_name: "registerSnapshot",
        parameter: "deps",
        call_sites: 1,
        call_sites_complete: true,
        electron_argument_locations: [
          { start: { line: 5, column: 28 }, end: { line: 5, column: 44 } },
        ],
        unresolved_arguments: 0,
      },
    });
    expect(
      graph.edges.find(
        ({ relation, target_node_id: target }) =>
          relation === "contains" && target === snapshot?.node_id,
      )?.evidence,
    ).toMatchObject({ state: "inferred", confidence: "medium" });

    const transported = located(graph, "ipc-handler", 7);
    expect(transported?.observations[0]?.properties).toMatchObject({
      channel: null,
      channel_expression: "channel",
      electron_identity: {
        function_name: "transport",
        unresolved_arguments: 1,
      },
    });
    expect(
      graph.edges.find(
        ({ relation, target_node_id: target }) =>
          relation === "contains" && target === transported?.node_id,
      )?.evidence,
    ).toMatchObject({ state: "inferred", confidence: "low" });

    expect(located(graph, "browser-window", 12)?.observations[0]).toMatchObject(
      {
        properties: {
          electron_identity: {
            function_name: "consent",
            parameter: "Window",
            parameter_index: 1,
            unresolved_arguments: 1,
          },
        },
        evidence: { state: "observed" },
      },
    );
    expect(
      located(graph, "context-bridge-api", 2)?.observations[0]?.properties,
    ).toMatchObject({
      api_key: "reliability",
      members: ["report"],
      electron_identity: { function_name: "expose", parameter: "bridge" },
    });
    expect(
      located(graph, "context-bridge-api", 7)?.observations[0]?.properties,
    ).toMatchObject({
      api_key: "desktop",
      api_status: "object-binding",
      members: [
        "openExternal",
        "theme",
        "theme.get",
        "update",
        "update.check",
        "update.quitAndInstall",
      ],
      conditional_members: ["chromeCookies"],
      unknown_members: 0,
    });
    expect(
      located(graph, "context-bridge-api", 10)?.observations[0]?.properties,
    ).toMatchObject({
      api_key: "patched",
      api_status: "object-binding",
      members: ["ready"],
      unknown_members: 1,
    });
  },
);
