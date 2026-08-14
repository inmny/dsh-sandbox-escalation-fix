import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { apply } from "../lib/index.js";

function escalationTool(name, received) {
  return {
    name,
    description: `${name} probe`,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
        sandbox_permissions: {
          type: "string",
          enum: ["workspace-write", "danger-full-access"],
        },
        justification: { type: "string" },
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args) {
      received.push(args);
      return "ok";
    },
  };
}

test("apply patches global and agent-scoped tools and restores them on dispose", async () => {
  const ctx = new Context();
  const agents = [];
  const globalTools = new Map();
  const scopedTools = new Map();
  const received = [];
  const globalBash = escalationTool("bash", received);
  const globalOriginal = globalBash.execute;
  globalTools.set("bash", globalBash);

  ctx.provide("agents", {
    list: () => [...agents],
  });
  ctx.provide("tools", {
    get(name, agent) {
      return scopedTools.get(agent)?.get(name) ?? globalTools.get(name);
    },
  });
  ctx.provide("sandboxPolicy", {
    defaultMode: "danger-full-access",
    workspaceRoot: process.cwd(),
    resolve(request) {
      return {
        mode: request?.session?.mode ?? "danger-full-access",
        workspaceRoot: process.cwd(),
      };
    },
    overrideOf: () => undefined,
  });

  apply(ctx);
  assert.notEqual(globalBash.execute, globalOriginal);

  await globalBash.execute({
    value: "global",
    sandbox_permissions: "danger-full-access",
    justification: "same mode",
  }, { agent: undefined });
  assert.deepEqual(received[0], { value: "global" });

  const agent = { session: { mode: "workspace-write" } };
  const scopedWrite = escalationTool("write", received);
  const scopedOriginal = scopedWrite.execute;
  agents.push(agent);
  scopedTools.set(agent, new Map([["write", scopedWrite]]));
  ctx.emit("agent/created", { agent });
  assert.notEqual(scopedWrite.execute, scopedOriginal);

  await scopedWrite.execute({
    value: "scoped",
    sandbox_permissions: "workspace-write",
    justification: "same mode",
  }, { agent });
  assert.deepEqual(received[1], { value: "scoped" });

  const lateEdit = escalationTool("edit", received);
  const lateOriginal = lateEdit.execute;
  globalTools.set("edit", lateEdit);
  ctx.emit("tools/change");
  assert.notEqual(lateEdit.execute, lateOriginal);

  globalTools.delete("edit");
  ctx.emit("tools/change");
  assert.equal(lateEdit.execute, lateOriginal);

  const replacementEdit = escalationTool("edit", received);
  const replacementOriginal = replacementEdit.execute;
  globalTools.set("edit", replacementEdit);
  ctx.emit("tools/change");
  assert.notEqual(replacementEdit.execute, replacementOriginal);

  agents.splice(agents.indexOf(agent), 1);
  scopedTools.delete(agent);
  ctx.emit("agent/disposed", { agent });
  assert.equal(scopedWrite.execute, scopedOriginal);

  await ctx.fiber.dispose();
  assert.equal(globalBash.execute, globalOriginal);
  assert.equal(scopedWrite.execute, scopedOriginal);
  assert.equal(lateEdit.execute, lateOriginal);
  assert.equal(replacementEdit.execute, replacementOriginal);
});

test("initial scan failure rolls back every earlier wrapper", async () => {
  const ctx = new Context();
  const received = [];
  const bash = escalationTool("bash", received);
  const bashOriginal = bash.execute;
  const pwsh = Object.freeze(escalationTool("pwsh", received));
  const tools = new Map([
    ["bash", bash],
    ["pwsh", pwsh],
  ]);

  ctx.provide("agents", { list: () => [] });
  ctx.provide("tools", {
    get: (name) => tools.get(name),
  });
  ctx.provide("sandboxPolicy", {
    defaultMode: "danger-full-access",
    workspaceRoot: process.cwd(),
    resolve: () => ({
      mode: "danger-full-access",
      workspaceRoot: process.cwd(),
    }),
    overrideOf: () => undefined,
  });

  assert.throws(() => apply(ctx), /tool "pwsh" execute is not a writable own property/);
  assert.equal(bash.execute, bashOriginal);

  const lateWrite = escalationTool("write", received);
  const lateOriginal = lateWrite.execute;
  tools.set("write", lateWrite);
  ctx.emit("tools/change");
  assert.equal(lateWrite.execute, lateOriginal);

  await ctx.fiber.dispose();
});

test("dynamic scan contains failure and keeps compatible patches", async () => {
  const ctx = new Context();
  const received = [];
  const bash = escalationTool("bash", received);
  const bashOriginal = bash.execute;
  const tools = new Map([["bash", bash]]);

  ctx.provide("agents", { list: () => [] });
  ctx.provide("tools", {
    get: (name) => tools.get(name),
  });
  ctx.provide("sandboxPolicy", {
    defaultMode: "danger-full-access",
    workspaceRoot: process.cwd(),
    resolve: () => ({
      mode: "danger-full-access",
      workspaceRoot: process.cwd(),
    }),
    overrideOf: () => undefined,
  });

  apply(ctx);
  assert.notEqual(bash.execute, bashOriginal);

  const write = escalationTool("write", received);
  const writeOriginal = write.execute;
  const edit = Object.freeze(escalationTool("edit", received));
  tools.set("write", write);
  tools.set("edit", edit);

  assert.doesNotThrow(() => ctx.emit("tools/change"));
  assert.notEqual(write.execute, writeOriginal);

  await ctx.fiber.dispose();
  assert.equal(bash.execute, bashOriginal);
  assert.equal(write.execute, writeOriginal);
});

test("incompatible agent-scoped tools cannot veto agent creation", async () => {
  const ctx = new Context();
  const agents = [];
  const scopedTools = new Map();
  const received = [];

  ctx.provide("agents", { list: () => [...agents] });
  ctx.provide("tools", {
    get(name, agent) {
      return scopedTools.get(agent)?.get(name);
    },
  });
  ctx.provide("sandboxPolicy", {
    defaultMode: "read-only",
    workspaceRoot: process.cwd(),
    resolve(request) {
      return {
        mode: request?.session?.mode ?? "read-only",
        workspaceRoot: process.cwd(),
      };
    },
    overrideOf: () => undefined,
  });

  apply(ctx);

  const agent = { id: "agent-probe", session: { mode: "workspace-write" } };
  const write = escalationTool("write", received);
  const writeOriginal = write.execute;
  const edit = Object.freeze(escalationTool("edit", received));
  agents.push(agent);
  scopedTools.set(agent, new Map([
    ["write", write],
    ["edit", edit],
  ]));

  assert.doesNotThrow(() => ctx.emit("agent/created", { agent }));
  assert.notEqual(write.execute, writeOriginal);

  await write.execute({
    value: "agent",
    sandbox_permissions: "workspace-write",
    justification: "same mode",
  }, { agent });
  assert.deepEqual(received[0], { value: "agent" });

  await ctx.fiber.dispose();
  assert.equal(write.execute, writeOriginal);
});
