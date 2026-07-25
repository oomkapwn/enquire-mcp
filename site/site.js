document.documentElement.classList.remove("no-js");

async function copyText(text) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based path when browser permissions deny
    // the asynchronous Clipboard API.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

for (const selector of document.querySelectorAll("[data-install-selector]")) {
  const tabs = [...selector.querySelectorAll('[role="tab"]')];
  const panels = [...selector.querySelectorAll('[role="tabpanel"]')];

  const activate = (tab) => {
    const client = tab.dataset.client;
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.panel !== client;
    }
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(tab);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next]?.focus();
      if (tabs[next]) activate(tabs[next]);
    });
  }
}

for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    const text = target?.textContent?.replace(/^\$\s?/gm, "").trim();
    if (!text) return;
    const original = button.textContent;
    button.textContent = (await copyText(text)) ? "Copied" : "Select and copy";
    window.setTimeout(() => {
      button.textContent = original;
    }, 1600);
  });
}
