/**
 * Build a registration-only view that can gate `registerTool` calls without
 * overwriting the SDK server instance.
 *
 * All non-tool methods are invoked against the original target. This matters
 * for SDK classes that keep private state and therefore cannot safely receive
 * the proxy as `this`. Direct synchronous fluent methods that return the
 * target are normalized back to the facade, including `valueOf()`. The
 * returned view may remain the public/runtime facade so later consumer
 * registrations keep the same filter semantics, while the original server
 * still owns every method invocation and all lifecycle state.
 *
 * This adapter preserves normal API behavior; it is not a same-process
 * security membrane against reflective access to SDK-private implementation
 * details.
 *
 * @param target - SDK server (or a compatible registration test double).
 * @param shouldRegister - Decision callback invoked once for every tool name.
 * @returns A registration view with identical static type and gated tools.
 * @example
 * ```ts
 * const registrar = createToolRegistrationAdapter(server, name => name !== "dangerous_tool");
 * registerTools(registrar);
 * return registrar;
 * ```
 */
export function createToolRegistrationAdapter<T extends object>(
  target: T,
  shouldRegister: (name: string) => boolean
): T {
  if (typeof Reflect.get(target, "registerTool", target) !== "function") {
    throw new TypeError("MCP registration target must expose registerTool()");
  }

  let facade: T;
  const registerToolMethods = new WeakMap<object, (...args: unknown[]) => unknown>();
  const registerToolSources = new WeakMap<object, unknown>();
  const boundMethods = new Map<PropertyKey, { source: unknown; method: (...args: unknown[]) => unknown }>();

  const gatedRegisterTool = (current: T): ((name: string, ...rest: unknown[]) => unknown) => {
    const source = Reflect.get(current, "registerTool", current);
    if (typeof source !== "function") {
      throw new TypeError("MCP registration target must expose registerTool()");
    }
    const cached = registerToolMethods.get(source);
    if (cached !== undefined) return cached;
    const method = (name: string, ...rest: unknown[]): unknown => {
      if (!shouldRegister(name)) return undefined;
      const result = Reflect.apply(source, current, [name, ...rest]);
      return result === current ? facade : result;
    };
    registerToolMethods.set(source, method);
    registerToolSources.set(method, source);
    return method;
  };

  facade = new Proxy(target, {
    get(current, property) {
      if (property === "registerTool") return gatedRegisterTool(current);
      const value = Reflect.get(current, property, current);
      if (typeof value !== "function" || property === "constructor") return value;
      const cached = boundMethods.get(property);
      if (cached?.source === value) return cached.method;
      const method = (...args: unknown[]): unknown => {
        const result = Reflect.apply(value, current, args);
        // Object.prototype.valueOf() and fluent SDK methods must preserve the
        // facade identity instead of leaking the raw target around the gate.
        return result === current ? facade : result;
      };
      boundMethods.set(property, { source: value, method });
      return method;
    },
    set(current, property, value) {
      if (property === "registerTool" && typeof value === "function") {
        // Assigning the facade method back to itself (or restoring it after a
        // spy) must not install our wrapper as its own source and recurse.
        const source = registerToolSources.get(value);
        return Reflect.set(current, property, source ?? value, current);
      }
      return Reflect.set(current, property, value, current);
    }
  });
  return facade;
}
