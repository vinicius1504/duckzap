import { normalize } from "./text";

/**
 * "Nunca responder fora do conhecimento → handoff" (§4.3), parte determinística:
 * antes de gastar o modelo `smart`, checamos se a pergunta tem algum apoio no conhecimento
 * (trechos recuperados ou texto do agente). O modelo também é instruído a chamar request_human.
 */

const STOP = new Set(
  (
    "para como qual quais quanto quanta quantos custa custam valor valores preco precos quero queria gostaria saber sobre voce voces " +
    "tem tenho temos fazem fazer esta estao aqui ainda pode podem poderia muito mais menos essa esse isso uma umas uns dos das nos nas " +
    "com sem por que onde quando porque tambem entao vamos obrigado obrigada ola boa bom dia tarde noite"
  ).split(" "),
);

export function keywords(text: string) {
  return [...new Set(normalize(text).replace(/[^a-z0-9 ]/g, " ").split(" ").filter((w) => w.length >= 4 && !STOP.has(w)))];
}

const SMALL_TALK = /^(oi+|ola|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|ok|certo|tudo bem|blz|beleza|tchau|ate (mais|logo)|sim|nao|entendi|combinado|teste|testando|testes)\b/;

// gírias de cumprimento: só valem quando são a mensagem inteira ("fala mano, tem site?" é pergunta de verdade)
const GREETING_ONLY = /^(opa+( bao)?( tudo bem)?|e a[i]|eai|iae|salve|fala( a[i])?|oie|oii+|hey|hello|boas|bao|fala ai)[\s!?.]*$/;

export function isSmallTalk(text: string) {
  const t = normalize(text);
  return (t.split(" ").length <= 5 && SMALL_TALK.test(t)) || GREETING_ONLY.test(t);
}

/** Alguma palavra relevante da pergunta aparece no conhecimento? Pergunta sem palavra relevante só passa se for papo social. */
export function hasKnowledgeOverlap(query: string, corpus: string) {
  const words = keywords(query);
  if (words.length === 0) return false;
  const haystack = normalize(corpus);
  return words.some((w) => haystack.includes(w.length > 5 ? w.slice(0, 5) : w));
}
