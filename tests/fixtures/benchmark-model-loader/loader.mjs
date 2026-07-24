const transformersFixture = new URL("./transformers.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@huggingface/transformers") {
    return { url: transformersFixture, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
