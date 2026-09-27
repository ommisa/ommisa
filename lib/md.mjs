// markdown → ANSI for the terminal. Zero-dependency, deliberately
// partial: headings, emphasis, inline code, fenced code, blockquotes,
// lists, rules and simple pipe tables — everything else passes through
// untouched. color=false yields clean plain text (piped output).

const B = "\x1b[1m", D = "\x1b[2m", U = "\x1b[4m", C = "\x1b[36m", R = "\x1b[0m";

export function renderMd(src, color = true) {
  const lines = String(src ?? "").split("\n");
  const out = [];
  let inCode = false;
  let tableBuf = [];

  const inline = (s) => {
    s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    if (!color) {
      return s
        .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1")
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1");
    }
    return s
      .replace(/`([^`]+)`/g, `${C}$1${R}`)
      .replace(/\*\*([^*]+)\*\*/g, `${B}$1${R}`)
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, `$1 ${D}($2)${R}`);
  };

  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf
      .map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
      .filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
    const widths = [];
    for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] || 0, c.length)));
    rows.forEach((r, ri) => {
      out.push(r.map((c, i) => (c + " ".repeat(widths[i])).slice(0, widths[i])).join(" │ "));
      if (ri === 0 && rows.length > 1) out.push(widths.map((w) => "─".repeat(w)).join("─┼─"));
    });
    tableBuf = [];
  };

  for (const raw of lines) {
    if (/^```/.test(raw.trim())) {
      flushTable();
      inCode = !inCode;
      if (color) out.push(inCode ? C : R);
      continue;
    }
    if (inCode) {
      out.push(raw);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      tableBuf.push(raw.trim());
      continue;
    }
    flushTable();
    const h = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (h) {
      out.push(`${color ? B + U : ""}${inline(h[2])}${color ? R : ""}`);
      continue;
    }
    if (/^\s*>\s?/.test(raw)) {
      out.push(`${color ? D : ""}│ ${inline(raw.replace(/^\s*>\s?/, ""))}${color ? R : ""}`);
      continue;
    }
    const li = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) {
      out.push(`${li[1]}${li[2].replace(/[-*]/, "•")} ${inline(li[3])}`);
      continue;
    }
    if (/^\s*([-=_])\1{2,}\s*$/.test(raw)) {
      out.push("─".repeat(40));
      continue;
    }
    out.push(inline(raw));
  }
  flushTable();
  return out.join("\n");
}
