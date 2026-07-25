const state = process.env.ENQUIRE_TEST_MODEL_STATE;
if (!["present", "missing", "corrupt"].includes(state)) {
  throw new Error(`Unknown ENQUIRE_TEST_MODEL_STATE: ${String(state)}`);
}

export const env = {
  allowLocalModels: true,
  allowRemoteModels: false
};

const DIM = 384;

function missing(stage) {
  if (state === "missing") throw new Error(`fixture model missing at ${stage}`);
}

function corrupt(stage) {
  if (state === "corrupt") throw new Error(`fixture model corrupt at ${stage}`);
}

function vectorFor(text) {
  const vector = new Float32Array(DIM);
  const source = String(text);
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    vector[(code + index * 17) % DIM] += 1 + (code % 7);
  }
  let normSquared = 0;
  for (const value of vector) normSquared += value * value;
  if (normSquared === 0) vector[0] = 1;
  else {
    const norm = Math.sqrt(normSquared);
    for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  }
  return vector;
}

export async function pipeline(task) {
  missing(`pipeline:${task}`);
  if (task !== "feature-extraction") throw new Error(`unexpected fixture pipeline task: ${task}`);
  return async (texts) => {
    corrupt("embedding inference");
    const input = Array.isArray(texts) ? texts : [texts];
    const data = new Float32Array(input.length * DIM);
    for (let index = 0; index < input.length; index++) {
      data.set(vectorFor(input[index]), index * DIM);
    }
    return { data, dims: [input.length, DIM] };
  };
}

export const AutoTokenizer = {
  async from_pretrained() {
    missing("reranker tokenizer load");
    return (queries, options = {}) => ({
      queries: Array.isArray(queries) ? queries.map(String) : [String(queries)],
      passages: Array.isArray(options.text_pair) ? options.text_pair.map(String) : [String(options.text_pair ?? "")]
    });
  }
};

export const AutoModelForSequenceClassification = {
  async from_pretrained() {
    missing("reranker model load");
    corrupt("reranker model load");
    return async ({ queries, passages }) => {
      const size = Math.max(queries.length, passages.length);
      const logits = new Float32Array(size);
      for (let index = 0; index < size; index++) {
        const query = queries[index] ?? queries[0] ?? "";
        const passage = passages[index] ?? passages[0] ?? "";
        const queryTerms = new Set(query.toLowerCase().split(/\W+/u).filter(Boolean));
        const overlap = passage
          .toLowerCase()
          .split(/\W+/u)
          .filter((term) => queryTerms.has(term)).length;
        logits[index] = overlap;
      }
      return { logits: { data: logits, dims: [size, 1] } };
    };
  }
};
