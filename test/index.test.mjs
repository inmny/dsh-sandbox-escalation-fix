import assert from "node:assert/strict";
import test from "node:test";
import {
  exposesSandboxEscalation,
  normalizeSameModeEscalation,
  patchToolDefinition,
} from "../lib/index.js";

function toolDefinition(execute, withEscalation = true) {
  return {
    name: "probe",
    description: "Probe tool",
    parameters: {
      type: "object",
      properties: withEscalation ? {
        value: { type: "string" },
        sandbox_permissions: {
          type: "string",
          enum: ["workspace-write", "danger-full-access"],
        },
        justification: { type: "string" },
      } : {
        value: { type: "string" },
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    execute,
  };
}

const exec = {
  agent: undefined,
};

test("removes a redundant danger-full-access request without mutating input", () => {
  const args = Object.freeze({
    value: "kept",
    sandbox_permissions: "danger-full-access",
    justification: "already granted",
  });

  const normalized = normalizeSameModeEscalation(args, "danger-full-access");

  assert.notEqual(normalized, args);
  assert.deepEqual(normalized, { value: "kept" });
  assert.equal(args.sandbox_permissions, "danger-full-access");
});

test("removes a redundant workspace-write request", () => {
  const normalized = normalizeSameModeEscalation({
    value: "kept",
    sandbox_permissions: "workspace-write",
    justification: "already granted",
  }, "workspace-write");

  assert.deepEqual(normalized, { value: "kept" });
});

test("preserves a genuinely wider escalation request", () => {
  const args = {
    sandbox_permissions: "workspace-write",
    justification: "write the workspace",
  };

  assert.equal(normalizeSameModeEscalation(args, "read-only"), args);
});

test("preserves a narrower request so DSH can reject it", () => {
  const args = {
    sandbox_permissions: "workspace-write",
    justification: "invalid downgrade",
  };

  assert.equal(normalizeSameModeEscalation(args, "danger-full-access"), args);
});

test("leaves unrelated arguments untouched", () => {
  const args = { value: "plain" };
  assert.equal(normalizeSameModeEscalation(args, "danger-full-access"), args);
  assert.equal(normalizeSameModeEscalation(null, "danger-full-access"), null);
});

test("detects only tools that expose the paired escalation fields", () => {
  assert.equal(exposesSandboxEscalation(toolDefinition(async () => "ok")), true);
  assert.equal(exposesSandboxEscalation(toolDefinition(async () => "ok", false)), false);
});

test("patch normalizes at execution time and restores the original function", async () => {
  const received = [];
  let mode = "danger-full-access";
  const definition = toolDefinition(async function (args) {
    received.push({ args, receiver: this });
    return "ok";
  });
  const original = definition.execute;
  const patch = patchToolDefinition(definition, () => mode);

  assert.ok(patch);
  assert.notEqual(definition.execute, original);

  const result = await definition.execute({
    value: "first",
    sandbox_permissions: "danger-full-access",
    justification: "same mode",
  }, exec);
  assert.equal(result, "ok");
  assert.deepEqual(received[0].args, { value: "first" });
  assert.equal(received[0].receiver, definition);

  mode = "read-only";
  const wider = {
    value: "second",
    sandbox_permissions: "workspace-write",
    justification: "wider mode",
  };
  await definition.execute(wider, exec);
  assert.equal(received[1].args, wider);

  patch.restore();
  assert.equal(definition.execute, original);
});

test("an unloaded wrapper stays inert if a later plugin restores it", async () => {
  const received = [];
  const definition = toolDefinition(async (args) => {
    received.push(args);
    return "ok";
  });
  const patch = patchToolDefinition(definition, () => "danger-full-access");
  assert.ok(patch);
  const ownedWrapper = definition.execute;

  const laterWrapper = async () => "later";
  definition.execute = laterWrapper;
  patch.restore();
  assert.equal(definition.execute, laterWrapper);

  // Simulate the later plugin unloading and restoring the predecessor it captured.
  definition.execute = ownedWrapper;
  const args = {
    sandbox_permissions: "danger-full-access",
    justification: "must remain after unload",
  };
  await definition.execute(args, exec);
  assert.equal(received[0], args);
});

test("rejects a frozen definition without changing its execute function", () => {
  const definition = Object.freeze(toolDefinition(async () => "ok"));
  const original = definition.execute;

  assert.throws(
    () => patchToolDefinition(definition, () => "danger-full-access"),
    /execute is not a writable own property/,
  );
  assert.equal(definition.execute, original);
});

test("does not patch tools without escalation parameters", () => {
  const definition = toolDefinition(async () => "ok", false);
  const original = definition.execute;
  assert.equal(patchToolDefinition(definition, () => "danger-full-access"), undefined);
  assert.equal(definition.execute, original);
});
