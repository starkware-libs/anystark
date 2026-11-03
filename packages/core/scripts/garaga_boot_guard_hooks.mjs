// Module-resolution boot guard, generalized over a SET of forbidden specifiers.
// Any attempt to resolve one of them while this hook is active is a boot-time
// load: exactly what must never happen for a dependency that is supposed to be
// reachable only via a dynamic `import(...)` off the boot path. The forbidden
// set is passed from assert_lazy.mjs through register()'s `data` option
// (initialize() below), so this module stays dep-agnostic.
let forbiddenSpecifiers = [];

export async function initialize(data) {
  forbiddenSpecifiers = (data && Array.isArray(data.forbidden) ? data.forbidden : []).slice();
}

export async function resolve(specifier, context, nextResolve) {
  for (const dep of forbiddenSpecifiers) {
    // Defense-in-depth: block the bare specifier and any subpath (dep + "/...").
    if (specifier === dep || specifier.startsWith(dep + "/")) {
      throw new Error(
        `LAZY_BOOT_RESOLVED: '${specifier}' was resolved during boot (forbidden lazy dependency)`,
      );
    }
  }
  return nextResolve(specifier, context);
}
