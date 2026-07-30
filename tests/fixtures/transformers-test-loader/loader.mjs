import { appendFileSync } from "node:fs";

const transformersFixture = new URL("./transformers.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@huggingface/transformers") {
    const marker = process.env.ENQUIRE_TEST_MODEL_MARKER;
    if (marker) appendFileSync(marker, `${specifier}\n`);
    return { url: transformersFixture, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
