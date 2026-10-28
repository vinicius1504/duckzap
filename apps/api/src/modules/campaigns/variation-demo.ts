import type { GenerateVariationsInput } from "@duckzap/contracts/campaigns";
import { ensureOptOut } from "./engine/variation";

// Gerador de DEMONSTRAÇÃO por regras, usado só quando a IA está em `LLM_PROVIDER=fake` (dev sem chave), para a tela
// de variações funcionar. Não é IA. Duas variações saem defeituosas DE PROPÓSITO (variável trocada, desconto inventado)
// para o validador de código aparecer em ação, como na versão de mock da tela. Com IA real isto não é usado.

const greetingRe = /^(oi|olá|ola|opa)[,!]?\s*\{nome\}\s*[!,.]?\s*/i;
const greetingPool = ["Oi, {nome}!", "Olá, {nome}!", "{nome}, tudo bem?", "Oi {nome}, tudo certo?", "Olá, {nome}! Como vai?", "Oi, {nome}! Tudo bem por aí?"];
const openerPool = ["", "Oi! ", "Tudo bem? ", "Olha só: ", "Passando para avisar: ", "Olá! "];
const closingPool = ["", " Qualquer dúvida, é só chamar.", " Estamos por aqui!", " Até breve!"];
const swaps: [RegExp, string[]][] = [
  [/Já faz um tempinho/g, ["Já faz um tempinho", "Faz um tempinho", "Já faz um tempo"]],
  [/Que tal agendar/g, ["Que tal agendar", "Que tal marcar", "Bora agendar"]],
  [/essa semana/g, ["essa semana", "nesta semana", "ainda esta semana"]],
  [/a gente cuida do resto/g, ["a gente cuida do resto", "a gente organiza tudo", "nós cuidamos do resto"]],
  [/Quer saber mais\?/g, ["Quer saber mais?", "Quer que eu conte mais?", "Posso te explicar melhor?"]],
  [/Como foi/g, ["Como foi", "Conta pra gente como foi"]],
];

export function demoVariationTexts(input: GenerateVariationsInput): string[] {
  const base = input.base.trim();
  const rest = base.replace(greetingRe, "");
  const hasGreeting = rest !== base;
  const seen = new Set<string>();
  const texts: string[] = [];
  for (let i = 0; texts.length < input.count && i < input.count * 6; i++) {
    let body = rest;
    let digits = Math.floor(i / greetingPool.length);
    swaps.forEach(([re, options]) => {
      body = body.replace(re, options[(digits + i) % options.length] ?? "");
      digits = Math.floor(digits / options.length);
    });
    const greeting = hasGreeting ? `${greetingPool[i % greetingPool.length]} ` : (openerPool[i % openerPool.length] ?? "");
    const closing = closingPool[(i * 3 + Math.floor(i / 4)) % closingPool.length] ?? "";
    let text = `${greeting}${body}${closing}`;
    if (text.trim() === base) continue;
    if (texts.length === 3) text = text.replace("{nome}", "você");
    if (texts.length === 11) text = `${text} Só hoje com 10% de desconto!`;
    // a 8ª sai sem a linha de saída (defeito proposital)
    const full = texts.length === 7 ? text : ensureOptOut(text, input.optOutLine);
    if (seen.has(full)) continue;
    seen.add(full);
    texts.push(full);
  }
  return texts;
}
