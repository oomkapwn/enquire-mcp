const WINDOWS_FORBIDDEN_COMPONENT_CHARS = /[<>:"|?*]/u;
const WINDOWS_RESERVED_DEVICE_STEM = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/iu;

function stripWindowsIgnoredSuffix(value: string): string {
  let end = value.length;
  while (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code !== 0x20 && code !== 0x2e) break;
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Return why a vault-relative path is unsafe under Win32 naming rules.
 *
 * The input must already be relative to the canonical vault root, so a
 * legitimate drive-letter colon is never inspected as a filename character.
 * Both slash styles are accepted because MCP clients can send either one.
 *
 * @param relativePath - Lexically contained vault-relative path.
 * @returns A stable reason string, or `null` when every component is safe.
 * @example
 * ```ts
 * windowsRelativePathProblem("Notes/Plan.md"); // null
 * windowsRelativePathProblem("Notes/CON.md"); // reserved-device reason
 * ```
 */
export function windowsRelativePathProblem(relativePath: string): string | null {
  if (relativePath === "") return null;

  for (const component of relativePath.split(/[\\/]/u)) {
    if (component === "" || component === "." || component === "..") {
      return `invalid path component ${JSON.stringify(component)}`;
    }
    const hasControlCharacter = [...component].some((character) => character.charCodeAt(0) <= 0x1f);
    if (WINDOWS_FORBIDDEN_COMPONENT_CHARS.test(component) || hasControlCharacter) {
      return `forbidden character in path component ${JSON.stringify(component)}`;
    }
    if (/[ .]$/u.test(component)) {
      return `path component ends with a dot or space: ${JSON.stringify(component)}`;
    }

    const stem = stripWindowsIgnoredSuffix(component.split(".", 1)[0] ?? "");
    if (WINDOWS_RESERVED_DEVICE_STEM.test(stem)) {
      return `reserved Windows device name in path component ${JSON.stringify(component)}`;
    }
  }

  return null;
}
