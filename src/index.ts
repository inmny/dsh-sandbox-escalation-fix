import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {
  ToolDefinition,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";

export const name = "sandbox-escalation-fix";
export const inject = ["agents", "tools", "sandboxPolicy"];

const TARGET_TOOL_NAMES = ["bash", "pwsh", "write", "edit"] as const;

type MutableToolDefinition = {
  -readonly [Key in keyof ToolDefinition]: ToolDefinition[Key];
};

type ModeResolver = (exec: ToolRunContext) => SandboxMode;

export interface ToolDefinitionPatch {
  readonly definition: ToolDefinition;
  restore(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exposesSandboxEscalation(
  definition: ToolDefinition,
): boolean {
  if (!isRecord(definition.parameters)) return false;
  const properties = definition.parameters.properties;
  return isRecord(properties)
    && Object.hasOwn(properties, "sandbox_permissions")
    && Object.hasOwn(properties, "justification");
}

export function normalizeSameModeEscalation(
  args: unknown,
  currentMode: SandboxMode,
): unknown {
  if (!isRecord(args) || args.sandbox_permissions !== currentMode) return args;

  const normalized = { ...args };
  delete normalized.sandbox_permissions;
  delete normalized.justification;
  return normalized;
}

export function patchToolDefinition(
  definition: ToolDefinition,
  resolveMode: ModeResolver,
): ToolDefinitionPatch | undefined {
  if (!exposesSandboxEscalation(definition)) return undefined;

  const descriptor = Object.getOwnPropertyDescriptor(definition, "execute");
  if (descriptor === undefined || !("value" in descriptor) || descriptor.writable !== true) {
    throw new Error(
      `sandbox-escalation-fix: tool "${definition.name}" execute is not a writable own property`,
    );
  }

  const mutable = definition as MutableToolDefinition;
  const original = definition.execute;
  let active = true;
  const wrapped = async function (
    this: ToolDefinition,
    args: unknown,
    exec: ToolRunContext,
  ): Promise<unknown> {
    const forwarded = active
      ? normalizeSameModeEscalation(args, resolveMode(exec))
      : args;
    return original.call(this, forwarded, exec);
  };

  try {
    mutable.execute = wrapped;
    if (definition.execute !== wrapped) {
      throw new Error("the assignment did not install the wrapper");
    }
  } catch (error) {
    active = false;
    try {
      if (definition.execute === wrapped) mutable.execute = original;
    } catch {
      // Preserve the first installation failure.
    }
    throw new Error(
      `sandbox-escalation-fix: failed to wrap tool "${definition.name}" execute`,
      { cause: error },
    );
  }

  return {
    definition,
    restore(): void {
      active = false;
      try {
        if (definition.execute === wrapped) mutable.execute = original;
      } catch {
        // The inactive wrapper is a safe pass-through if another owner froze it.
      }
    },
  };
}

export function apply(ctx: Context): void {
  const patches = new Map<ToolDefinition, ToolDefinitionPatch>();
  const incompatible = new WeakSet<ToolDefinition>();

  const resolveMode: ModeResolver = (exec) => ctx.sandboxPolicy.resolve(
    exec.agent === undefined ? undefined : { session: exec.agent.session },
  ).mode;

  const restore = (selected: readonly ToolDefinitionPatch[]): void => {
    for (const patch of [...selected].reverse()) {
      patches.delete(patch.definition);
      patch.restore();
    }
  };

  const restoreAll = (): void => {
    const activePatches = [...patches.values()];
    patches.clear();
    for (const patch of activePatches.reverse()) patch.restore();
  };

  const patchVisibleTools = (
    agent: Agent | undefined,
    added: ToolDefinitionPatch[],
  ): void => {
    for (const toolName of TARGET_TOOL_NAMES) {
      const definition = ctx.tools.get(toolName, agent);
      if (definition === undefined || patches.has(definition)) continue;
      const patch = patchToolDefinition(definition, resolveMode);
      if (patch === undefined) continue;
      patches.set(definition, patch);
      added.push(patch);
    }
  };

  const scanTransaction = (agents: readonly (Agent | undefined)[]): void => {
    const added: ToolDefinitionPatch[] = [];
    try {
      for (const agent of agents) patchVisibleTools(agent, added);
    } catch (error) {
      restore(added);
      throw error;
    }
  };

  const scanAll = (): void => {
    scanTransaction([undefined, ...ctx.agents.list()]);
  };

  const errorText = (error: unknown): string => {
    try {
      return error instanceof Error ? error.message : String(error);
    } catch {
      return "unprintable error";
    }
  };

  const warnSafely = (source: string, error: unknown): void => {
    try {
      ctx.logger.warn(
        `sandbox-escalation-fix: skipped incompatible ${source}: ${errorText(error)}`,
      );
    } catch {
      // Runtime compatibility events must never veto tool or agent registration.
    }
  };

  const scanSafely = (
    source: string,
    selectAgents: () => readonly (Agent | undefined)[],
    pruneInvisible: boolean,
  ): void => {
    let agents: readonly (Agent | undefined)[];
    try {
      agents = selectAgents();
    } catch (error) {
      warnSafely(`${source} scope scan`, error);
      return;
    }

    const visible = new Set<ToolDefinition>();
    let complete = true;
    for (const agent of agents) {
      for (const toolName of TARGET_TOOL_NAMES) {
        try {
          const definition = ctx.tools.get(toolName, agent);
          if (definition !== undefined) visible.add(definition);
        } catch (error) {
          complete = false;
          warnSafely(`${source} tool "${toolName}" lookup`, error);
        }
      }
    }

    for (const definition of visible) {
      if (patches.has(definition) || incompatible.has(definition)) continue;
      try {
        const patch = patchToolDefinition(definition, resolveMode);
        if (patch !== undefined) patches.set(definition, patch);
      } catch (error) {
        incompatible.add(definition);
        warnSafely(`${source} target definition`, error);
      }
    }

    if (!pruneInvisible || !complete) return;
    for (const [definition, patch] of [...patches]) {
      if (visible.has(definition)) continue;
      patches.delete(definition);
      patch.restore();
    }
  };

  ctx.effect(() => {
    let stopChange: (() => void) | undefined;
    let stopCreated: (() => void) | undefined;
    let stopDisposed: (() => void) | undefined;
    try {
      scanAll();
      stopChange = ctx.on("tools/change", () => {
        scanSafely("runtime", () => [undefined, ...ctx.agents.list()], true);
      });
      stopCreated = ctx.on("agent/created", ({ agent }) => {
        scanSafely("new agent", () => [agent], false);
      });
      stopDisposed = ctx.on("agent/disposed", () => {
        scanSafely("agent disposal", () => [undefined, ...ctx.agents.list()], true);
      });
    } catch (error) {
      stopDisposed?.();
      stopCreated?.();
      stopChange?.();
      restoreAll();
      throw error;
    }

    return () => {
      stopDisposed?.();
      stopCreated?.();
      stopChange?.();
      restoreAll();
    };
  }, "sandbox-escalation-fix.lifecycle()");
}
