/** Divide o texto extraído em trechos de ~`target` caracteres, respeitando parágrafos e frases (sem cortar palavras). */
export function chunkText(text: string, target = 900): string[] {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!clean) return [];
  const units: string[] = [];
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= target) {
      units.push(p);
      continue;
    }
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (sentence.length <= target) units.push(sentence);
      else for (let i = 0; i < sentence.length; i += target) units.push(sentence.slice(i, i + target));
    }
  }
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current && current.length + unit.length + 1 > target) {
      chunks.push(current);
      current = unit;
    } else {
      current = current ? `${current}\n${unit}` : unit;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function documentKind(fileName: string): "pdf" | "docx" | "txt" | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext === "pdf" || ext === "docx" || ext === "txt" ? ext : null;
}
