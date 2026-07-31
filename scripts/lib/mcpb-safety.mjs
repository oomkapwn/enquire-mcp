/**
 * Normalize one archive entry and reject paths that cannot be extracted with
 * the same identity on the supported macOS, Windows, and Linux runners.
 */
export function portableArchivePath(rawName) {
  const name = rawName.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = name.split("/");
  if (!name || name.startsWith("/") || /^[A-Za-z]:\//.test(name) || name.endsWith("/")) {
    throw new Error(`unsafe archive path: ${rawName}`);
  }
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`archive traversal or empty segment: ${rawName}`);
    }
    if (/[<>:"|?*]/u.test(segment) || [...segment].some((character) => (character.codePointAt(0) ?? 32) <= 31)) {
      throw new Error(`Windows-invalid archive segment: ${rawName}`);
    }
    if (/[ .]$/u.test(segment)) {
      throw new Error(`Windows-trimmed archive segment: ${rawName}`);
    }
    const dot = segment.indexOf(".");
    const stem = segment.slice(0, dot === -1 ? segment.length : dot).replace(/[ .]+$/u, "");
    if (/^(?:clock\$|con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(stem)) {
      throw new Error(`Windows-reserved archive segment: ${rawName}`);
    }
  }
  return name;
}

/** Return the portable collision identity used before extraction. */
export function portableArchiveKey(name) {
  return name.normalize("NFC").toLowerCase();
}

const NATIVE_BINARY_NAME = /(?:\.(?:dll|dylib|exe|node|wasm)|\.so(?:\.\d+)*)$/iu;
const FOUR_BYTE_BINARY_MAGICS = new Map([
  ["0061736d", "WebAssembly"],
  ["7f454c46", "ELF"],
  ["bebafeca", "Mach-O universal"],
  ["bfbafeca", "Mach-O universal"],
  ["cafebabe", "Mach-O universal or Java class"],
  ["cafebabf", "Mach-O universal"],
  ["cefaedfe", "Mach-O"],
  ["cffaedfe", "Mach-O"],
  ["feedface", "Mach-O"],
  ["feedfacf", "Mach-O"]
]);

/** Detect native/executable payloads by portable name and magic bytes. */
export function nativeBinaryReason(name, data) {
  if (NATIVE_BINARY_NAME.test(name)) return `native/executable filename ${name}`;
  const prefix = [...data.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (prefix.startsWith("4d5a")) return "PE executable magic";
  return FOUR_BYTE_BINARY_MAGICS.get(prefix) ?? null;
}

/** Resolve every mandatory dependency or fail instead of emitting an incomplete SBOM edge set. */
export function resolveRequiredDependencyRefs(manifest, resolve) {
  const result = [];
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const resolved = resolve(dependency);
    if (!resolved) {
      throw new Error(
        `MCPB SBOM could not resolve required dependency ${dependency} from ${manifest.name}@${manifest.version}`
      );
    }
    result.push(resolved);
  }
  return result;
}
