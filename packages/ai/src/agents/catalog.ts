import { normalize } from "./text";
import type { AgentRuntimeConfig } from "./types";

/**
 * Catálogo de produtos para a IA (V1). Este arquivo é PURO: sem banco, sem rede.
 *
 * O foco é achar o produto MAIS PRÓXIMO do que o cliente pediu ("camizeta preta", "camisa preta g", "aquela do vestido azul")
 * e deixar claro o quanto de certeza há: `confidence` alta só quando o produto bate sem depender de adivinhação e sem
 * concorrente parecido; erro de digitação, nome parcial ou variantes (M e G) viram "média" e a IA CONFIRMA com o cliente.
 * Variantes (tamanho, cor) são produtos separados, então "camiseta preta" devolve vários candidatos com nota parecida.
 */

export type Confidence = "high" | "medium" | "low";

export type RankableProduct = { id: string; name: string; description: string };

export type RankedProduct<T extends RankableProduct = RankableProduct> = {
  product: T;
  /** 0 a 1. Só serve para ordenar e comparar candidatos. */
  score: number;
  confidence: Confidence;
  /** Outro candidato tem nota quase igual: a IA deve perguntar qual dos dois o cliente quer. */
  ambiguous: boolean;
};

/** Abaixo disto o produto nem é citado como palpite. */
export const MIN_SCORE = 0.3;
const HIGH_SCORE = 0.78;
const MEDIUM_SCORE = 0.5;
/** Diferença de nota abaixo da qual dois candidatos contam como "parecidos". */
const AMBIGUITY_MARGIN = 0.08;
/** Peso do trecho da descrição frente ao nome ao casar uma palavra. */
const DESCRIPTION_WEIGHT = 0.4;
/** Casamento bom o bastante para não depender de adivinhar (igual ou começo da palavra). */
const SOLID_MATCH = 0.85;

const STOPWORDS = new Set(
  (
    "a o as os um uma uns umas de do da dos das em no na nos nas ao aos e ou que com para pra por pro tem tinha tenho ter temos " +
    "quero queria queremos gostaria preciso precisava saber ver veja mostra mostrar manda mandar me meu minha meus minhas " +
    "foto fotos imagem imagens valor valores preco precos quanto quantos custa custam sai ficou fica " +
    "esse essa esses essas isso este esta isto aquele aquela aqueles aquelas aquilo " +
    "voce voces vc vcs ai ola oi bom boa dia tarde noite favor " +
    "qual quais tipo modelo produto item opcao mais tambem ainda so la aqui ta tao muito pouco " +
    "vende vendem vendo venda comprar compra quanto"
  ).split(" "),
);

/** Tira acento, símbolos e plural simples ("camisetas" → "camiseta"). Tokens são minúsculos e só têm letras e números. */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

/** Distância de edição com troca de letras vizinhas (Damerau/OSA): "camiseat" → "camiseta" vale 1. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i]![0] = i;
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Nota de uma palavra do cliente contra uma palavra do produto: 1 igual; 0,85 começo da palavra ("camis" → "camiseta");
 * 0,8/0,7 erro de digitação (1 ou 2 letras). Palavras curtas e números (tamanho "g", "38", "500") só casam exatas.
 */
function tokenScore(q: string, p: string): number {
  if (q === p) return 1;
  if (q.length <= 3 || p.length <= 3) return 0;
  if (/^\d+$/.test(q) || /^\d+$/.test(p)) return 0;
  if (q.length >= 4 && p.length > q.length && p.startsWith(q)) return SOLID_MATCH;
  const allowed = Math.max(q.length, p.length) <= 6 ? 1 : 2;
  if (Math.abs(q.length - p.length) > allowed) return 0;
  const distance = editDistance(q, p);
  return distance > 0 && distance <= allowed ? 0.9 - 0.1 * distance : 0;
}

function trigrams(text: string): Set<string> {
  const padded = ` ${text} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Coeficiente de Dice entre os trigramas de dois textos já normalizados (0 a 1). */
function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let common = 0;
  for (const g of ta) if (tb.has(g)) common++;
  return (2 * common) / (ta.size + tb.size);
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

type Scored<T extends RankableProduct> = { product: T; score: number; baseLevel: Confidence };

function scoreProduct<T extends RankableProduct>(product: T, queryTokens: string[], queryText: string): Scored<T> {
  const nameTokens = unique(tokenize(product.name));
  const descriptionTokens = unique(tokenize(product.description));

  let sum = 0;
  let allSolid = true;
  let allMatched = true;
  const matchedNameTokens = new Set<string>();
  for (const q of queryTokens) {
    let nameBest = 0;
    let nameBestToken = "";
    for (const n of nameTokens) {
      const s = tokenScore(q, n);
      if (s > nameBest) {
        nameBest = s;
        nameBestToken = n;
      }
    }
    let descriptionBest = 0;
    for (const d of descriptionTokens) descriptionBest = Math.max(descriptionBest, tokenScore(q, d));
    const best = Math.max(nameBest, descriptionBest * DESCRIPTION_WEIGHT);
    sum += best;
    if (nameBest > 0) matchedNameTokens.add(nameBestToken);
    if (best === 0) allMatched = false;
    // "casou de verdade" = igual ou começo da palavra (no nome ou na descrição); erro de digitação não conta
    if (nameBest < SOLID_MATCH && descriptionBest < SOLID_MATCH) allSolid = false;
  }
  const coverage = sum / queryTokens.length;
  const nameCoverage = nameTokens.length ? matchedNameTokens.size / nameTokens.length : 0;
  const similarity = trigramSimilarity(queryTokens.join(" "), nameTokens.join(" "));
  const score = Math.min(1, 0.65 * coverage + 0.2 * similarity + 0.1 * nameCoverage + (allMatched ? 0.05 : 0));

  // nome inteiro digitado igual (sem acento e plural) vale nota máxima: desempata "Camiseta Preta" de "Camiseta Preta Manga Longa"
  const exactName = nameTokens.length > 0 && nameTokens.join(" ") === queryText;
  const final = exactName ? 1 : score;
  let baseLevel: Confidence = final >= HIGH_SCORE ? "high" : final >= MEDIUM_SCORE ? "medium" : "low";
  // palavra casada só por aproximação (erro de digitação) nunca é "alta": a IA confirma com o cliente
  if (baseLevel === "high" && !allSolid && !exactName) baseLevel = "medium";
  return { product, score: final, baseLevel };
}

/**
 * Ordena os produtos pelo quanto se parecem com o pedido do cliente. Só devolve quem passa de `MIN_SCORE`. Quem chama decide
 * antes quais produtos entram (disponíveis, da empresa). Lista vazia ou pedido sem palavra útil ("tem?") devolve `[]`.
 */
export function rankProducts<T extends RankableProduct>(query: string, products: readonly T[], options: { limit?: number } = {}): RankedProduct<T>[] {
  const limit = options.limit ?? 3;
  const queryTokens = unique(tokenize(query));
  if (queryTokens.length === 0 || products.length === 0) return [];
  const queryText = queryTokens.join(" ");

  const scored = products
    .map((p) => scoreProduct(p, queryTokens, queryText))
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name, "pt-BR"));

  const top = scored.slice(0, limit);
  return top.map((s): RankedProduct<T> => {
    // outro candidato (da lista toda, não só do corte) com nota quase igual e que também é plausível
    const ambiguous = s.score >= MEDIUM_SCORE && scored.some((o) => o !== s && o.score >= MEDIUM_SCORE && Math.abs(o.score - s.score) < AMBIGUITY_MARGIN);
    const confidence: Confidence = ambiguous && s.baseLevel === "high" ? "medium" : s.baseLevel;
    return { product: s.product, score: Math.round(s.score * 1000) / 1000, confidence, ambiguous };
  });
}

// ---------- configuração (função do sistema, como a agenda) ----------

/**
 * O catálogo é função do SISTEMA, não de cada agente: com ao menos um produto disponível na empresa, qualquer agente que
 * atende (ao vivo, Copiloto e simulador) ganha `search_products`, `send_product_photos` e `register_interest`. Sem produto
 * disponível as ferramentas não existem e a IA não promete mostrar nada. Quem monta o turno chama isto ANTES de `runAgentTurn`.
 * Pura: não muda o objeto recebido.
 */
export function effectiveCatalogConfig(config: AgentRuntimeConfig, hasAvailableProducts: boolean): AgentRuntimeConfig {
  return { ...config, catalog: { enabled: hasAvailableProducts } };
}

/** "R$ 59,90" / "R$ 1.299,90". Igual ao `formatPriceBRL` do contrato (o guardrail de preço reconhece este formato). */
export function formatPrice(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `R$ ${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${frac}`;
}
