import { DEFAULT_OPT_OUT_LINE, INTERVAL_FLOOR_SECONDS, splitIntoDays, validateVariation } from "@duckzap/contracts/campaigns";
import { describe, expect, it } from "vitest";
import { classifyAudience, dedupeKey, orderAudience, type AudienceRow } from "./audience";
import { classifyFailure, evaluateBreaker, evaluateInviteBreaker, type Outcome } from "./breaker";
import { addDays, easter, isHoliday, isSendDay, isValidWindow, isWithinWindow, localParts, nationalHolidays, nextWindowOpening, zonedToUtc, type SendWindow } from "./calendar";
import { LONG_PAUSE_EVERY, LONG_PAUSE_SECONDS, effectiveBounds, initialSamplerState, nextInterval, typingDurationMs, type SamplerState } from "./intervals";
import { checkLaunch, type LaunchFacts } from "./launch-rules";
import { checkSendGate, dailyLimitFor, hourlyLimitFor, numberAgeDays, splitWithWarmup } from "./limits";
import { seeded, shuffle } from "./rng";
import { projectDayPlan } from "./schedule";
import { composeBody, degradeToText, drawFromBag, ensureOptOut, firstName, renderVariables, type BankEntry } from "./variation";
import { parseVariationTexts, toVariations } from "../variation-gen";
import { demoVariationTexts } from "../variation-demo";
import { maskPhone } from "../repo";

// Testes PUROS do motor de envio seguro (§5.7): sem banco, sem relógio, sem rede. RNG sempre com semente.

const TZ = "America/Sao_Paulo";
const window: SendWindow = { start: "08:00", end: "20:00", skipSundaysAndHolidays: true, timeZone: TZ };
/** instante a partir de data/hora LOCAL em São Paulo (UTC-3, sem horário de verão desde 2019) */
const at = (date: string, time: string) => zonedToUtc(date, time, TZ);

describe("limites e aquecimento (§5.7 item 2)", () => {
  it("QR: dias 1–3 → 10, 4–7 → 25, depois 50; oficial não usa o teto do QR", () => {
    expect([1, 2, 3].map((d) => dailyLimitFor("whatsapp_qr", d))).toEqual([10, 10, 10]);
    expect([4, 5, 7].map((d) => dailyLimitFor("whatsapp_qr", d))).toEqual([25, 25, 25]);
    expect([8, 30, 400].map((d) => dailyLimitFor("whatsapp_qr", d))).toEqual([50, 50, 50]);
    expect(hourlyLimitFor("whatsapp_qr")).toBe(15);
    expect(dailyLimitFor("whatsapp_official", 1)).toBeGreaterThan(50);
  });

  it("idade do número em dias corridos, começando em 1", () => {
    const connected = new Date("2026-10-20T15:00:00Z");
    expect(numberAgeDays(connected, new Date("2026-10-20T15:30:00Z"))).toBe(1);
    expect(numberAgeDays(connected, new Date("2026-10-21T15:00:00Z"))).toBe(2);
    expect(numberAgeDays(connected, new Date("2026-10-26T14:59:00Z"))).toBe(6);
    expect(numberAgeDays(connected, new Date("2026-10-10T00:00:00Z"))).toBe(1); // nunca abaixo de 1
  });

  it("barra o 51º do dia e o 16º da hora; o horário libera quando o mais antigo completa 1 h", () => {
    const now = new Date("2026-10-26T15:00:00Z");
    expect(checkSendGate("whatsapp_qr", 100, { sentToday: 49, sentTimesLastHour: [] }, now)).toEqual({ allowed: true });
    expect(checkSendGate("whatsapp_qr", 100, { sentToday: 50, sentTimesLastHour: [] }, now)).toEqual({ allowed: false, reason: "daily_limit", retryAt: null });
    // 15 envios na última hora: o mais antigo foi há 50 min → libera daqui a 10 min
    const times = Array.from({ length: 15 }, (_, i) => now.getTime() - (50 - i * 3) * 60_000);
    const gate = checkSendGate("whatsapp_qr", 100, { sentToday: 20, sentTimesLastHour: times }, now);
    expect(gate).toMatchObject({ allowed: false, reason: "hourly_limit" });
    expect(gate.allowed === false && gate.retryAt?.getTime()).toBe(now.getTime() + 10 * 60_000);
    // 14 na hora: passa
    expect(checkSendGate("whatsapp_qr", 100, { sentToday: 20, sentTimesLastHour: times.slice(1) }, now).allowed).toBe(true);
    // fora da hora não conta
    expect(checkSendGate("whatsapp_qr", 100, { sentToday: 20, sentTimesLastHour: times.map((t) => t - 3 * 3_600_000) }, now).allowed).toBe(true);
  });

  it("número em aquecimento: o teto diário vale (10 no dia 1)", () => {
    const now = new Date("2026-10-26T15:00:00Z");
    expect(checkSendGate("whatsapp_qr", 1, { sentToday: 10, sentTimesLastHour: [] }, now)).toMatchObject({ allowed: false, reason: "daily_limit" });
    expect(checkSendGate("whatsapp_qr", 1, { sentToday: 9, sentTimesLastHour: [] }, now).allowed).toBe(true);
  });
});

describe("divisão em dias (usa os helpers do contrato)", () => {
  it("número aquecido: igual a splitIntoDays do contrato (64 → 50 + 14)", () => {
    expect(splitWithWarmup(64, "whatsapp_qr", 214, 0)).toEqual(splitIntoDays(64, 50, 0));
    expect(splitWithWarmup(64, "whatsapp_qr", 214, 0)).toEqual([50, 14]);
    expect(splitWithWarmup(64, "whatsapp_qr", 214, 40)).toEqual([10, 50, 4]);
  });

  it("número novo: o limite sobe ao longo dos dias (10, 10, 10, 25, …)", () => {
    expect(splitWithWarmup(64, "whatsapp_qr", 1, 0)).toEqual([10, 10, 10, 25, 9]);
    expect(splitWithWarmup(64, "whatsapp_qr", 1, 0).reduce((a, b) => a + b, 0)).toBe(64);
    // dia 3 com 4 já enviados: 6 hoje, depois 25 (dia 4) e 25 (dia 5)…
    expect(splitWithWarmup(40, "whatsapp_qr", 3, 4)).toEqual([6, 25, 9]);
  });

  it("hoje esgotado: começa amanhã com o limite do dia seguinte", () => {
    expect(splitWithWarmup(30, "whatsapp_qr", 3, 10)).toEqual([25, 5]);
    expect(splitWithWarmup(0, "whatsapp_qr", 3, 0)).toEqual([]);
  });

  it("plano de datas: 64 pessoas = 2 dias; sexta com 120 pula domingo e feriado (Finados 02/11)", () => {
    const monday10h = at("2026-10-26", "10:00");
    const base = { kind: "whatsapp_qr" as const, ageDays: 300, sentToday: 0, from: monday10h, now: monday10h, window };
    expect(projectDayPlan({ ...base, count: 64 })).toEqual([
      { date: "2026-10-26", count: 50 },
      { date: "2026-10-27", count: 14 },
    ]);
    const friday = at("2026-10-30", "09:00");
    expect(projectDayPlan({ ...base, count: 120, from: friday, now: friday })).toEqual([
      { date: "2026-10-30", count: 50 },
      { date: "2026-10-31", count: 50 },
      { date: "2026-11-03", count: 20 },
    ]);
  });

  it("fora da janela ou com o dia esgotado, começa no próximo dia permitido", () => {
    const monday21h = at("2026-10-26", "21:00");
    expect(projectDayPlan({ kind: "whatsapp_qr", ageDays: 300, sentToday: 0, from: monday21h, now: monday21h, window, count: 10 })).toEqual([{ date: "2026-10-27", count: 10 }]);
    const monday10h = at("2026-10-26", "10:00");
    expect(projectDayPlan({ kind: "whatsapp_qr", ageDays: 300, sentToday: 50, from: monday10h, now: monday10h, window, count: 10 })).toEqual([{ date: "2026-10-27", count: 10 }]);
    // agendada para daqui a uma semana
    const scheduled = at("2026-11-03", "12:00");
    expect(projectDayPlan({ kind: "whatsapp_qr", ageDays: 300, sentToday: 40, from: scheduled, now: monday10h, window, count: 21 })).toEqual([{ date: "2026-11-03", count: 21 }]);
  });
});

describe("calendário, janela de envio, domingo e feriado", () => {
  it("fuso: 13:00Z é 10:00 em São Paulo; conversão de ida e volta", () => {
    expect(localParts(new Date("2026-10-26T13:00:00Z"), TZ)).toMatchObject({ date: "2026-10-26", hour: 10, minute: 0, weekday: 1 });
    expect(zonedToUtc("2026-10-26", "08:00", TZ).toISOString()).toBe("2026-10-26T11:00:00.000Z");
    expect(localParts(new Date("2026-10-27T02:30:00Z"), TZ).date).toBe("2026-10-26"); // 23:30 local ainda é dia 26
  });

  it("feriados nacionais e móveis (2026): Páscoa 05/04, Sexta Santa 03/04, Carnaval 16–17/02, Corpus Christi 04/06", () => {
    expect(easter(2026)).toBe("2026-04-05");
    const h = nationalHolidays(2026);
    for (const d of ["2026-01-01", "2026-04-03", "2026-02-16", "2026-02-17", "2026-06-04", "2026-09-07", "2026-11-02", "2026-12-25"]) expect(h.has(d), d).toBe(true);
    expect(isHoliday("2026-10-26")).toBe(false);
  });

  it("domingo e feriado só bloqueiam quando pedido", () => {
    expect(isSendDay("2026-11-01", true)).toBe(false); // domingo
    expect(isSendDay("2026-11-01", false)).toBe(true);
    expect(isSendDay("2026-11-02", true)).toBe(false); // Finados (segunda)
    expect(isSendDay("2026-11-03", true)).toBe(true);
    expect(isSendDay("2026-10-31", true)).toBe(true); // sábado é permitido
  });

  it("janela 08h–20h: dentro, antes, depois, domingo", () => {
    expect(isWithinWindow(at("2026-10-26", "08:00"), window)).toBe(true);
    expect(isWithinWindow(at("2026-10-26", "19:59"), window)).toBe(true);
    expect(isWithinWindow(at("2026-10-26", "20:00"), window)).toBe(false);
    expect(isWithinWindow(at("2026-10-26", "07:59"), window)).toBe(false);
    expect(isWithinWindow(at("2026-11-01", "10:00"), window)).toBe(false);
    expect(isWithinWindow(at("2026-11-01", "10:00"), { ...window, skipSundaysAndHolidays: false })).toBe(true);
  });

  it("próxima abertura: mesmo dia de manhã, dia seguinte à noite, pulando domingo e feriado", () => {
    expect(nextWindowOpening(at("2026-10-26", "06:00"), window).toISOString()).toBe(at("2026-10-26", "08:00").toISOString());
    expect(nextWindowOpening(at("2026-10-26", "21:00"), window).toISOString()).toBe(at("2026-10-27", "08:00").toISOString());
    // sábado à noite → domingo (bloqueado) → segunda 02/11 (Finados, bloqueado) → terça 03/11
    expect(nextWindowOpening(at("2026-10-31", "21:00"), window).toISOString()).toBe(at("2026-11-03", "08:00").toISOString());
    const now = at("2026-10-26", "12:00");
    expect(nextWindowOpening(now, window)).toBe(now);
  });

  it("janela inválida (fim antes do início) é rejeitada", () => {
    expect(isValidWindow("08:00", "20:00")).toBe(true);
    expect(isValidWindow("20:00", "08:00")).toBe(false);
    expect(isValidWindow("08:00", "08:00")).toBe(false);
    expect(isValidWindow("8:00", "20:00")).toBe(false);
  });

  it("addDays atravessa mês e ano", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("sorteador de intervalos (§5.7 item 3)", () => {
  function run(seed: number, n: number, config = { minSeconds: 45, maxSeconds: 120 }) {
    const rng = seeded(seed);
    let state: SamplerState = initialSamplerState(rng);
    const out: { seconds: number; pause: number | null }[] = [];
    for (let i = 0; i < n; i++) {
      const next = nextInterval(config, state, rng);
      out.push({ seconds: next.seconds, pause: next.longPauseSeconds });
      state = next.state;
    }
    return out;
  }

  it("sempre dentro de [mín, máx], com piso de 30 s", () => {
    for (const seed of [1, 7, 42, 2026]) {
      for (const { seconds } of run(seed, 3000)) {
        expect(seconds).toBeGreaterThanOrEqual(45);
        expect(seconds).toBeLessThanOrEqual(120);
      }
    }
  });

  it("piso de 30 s vale mesmo se a configuração pedir menos", () => {
    expect(effectiveBounds({ minSeconds: 5, maxSeconds: 20 })).toEqual({ min: INTERVAL_FLOOR_SECONDS, max: 31 });
    for (const { seconds } of run(5, 2000, { minSeconds: 1, maxSeconds: 60 })) expect(seconds).toBeGreaterThanOrEqual(30);
  });

  it("nunca dois intervalos iguais seguidos (nem em faixa estreita)", () => {
    for (const config of [{ minSeconds: 45, maxSeconds: 120 }, { minSeconds: 40, maxSeconds: 41 }, { minSeconds: 30, maxSeconds: 32 }]) {
      const seq = run(99, 5000, config);
      for (let i = 1; i < seq.length; i++) expect(seq[i]?.seconds).not.toBe(seq[i - 1]?.seconds);
    }
  });

  it("distribuição irregular: não é uniforme (média abaixo do meio) e usa a faixa toda, com muitos valores distintos", () => {
    const seq = run(2024, 10_000).map((x) => x.seconds);
    const mean = seq.reduce((a, b) => a + b, 0) / seq.length;
    expect(mean).toBeLessThan(80); // uniforme daria ~82,5 (desvio da média ~0,2 com 10 mil)
    const sorted = [...seq].sort((x, y) => x - y);
    expect(sorted[Math.floor(sorted.length / 2)] ?? 0).toBeLessThan(mean - 3); // assimetria à direita: mediana bem abaixo da média
    expect(new Set(seq).size).toBeGreaterThan(60);
    expect(Math.max(...seq)).toBeGreaterThan(110); // cauda longa
    // metade inferior mais cheia que a superior
    const low = seq.filter((s) => s < 82.5).length;
    expect(low / seq.length).toBeGreaterThan(0.58);
  });

  it("pausa longa a cada 8–15 mensagens, de 5 a 15 min, e só nessas", () => {
    const seq = run(31337, 600);
    const positions = seq.flatMap((x, i) => (x.pause !== null ? [i + 1] : []));
    expect(positions.length).toBeGreaterThan(30);
    let previous = 0;
    for (const p of positions) {
      const gap = p - previous;
      expect(gap).toBeGreaterThanOrEqual(LONG_PAUSE_EVERY.min);
      expect(gap).toBeLessThanOrEqual(LONG_PAUSE_EVERY.max);
      previous = p;
    }
    for (const x of seq) {
      if (x.pause === null) continue;
      expect(x.pause).toBeGreaterThanOrEqual(LONG_PAUSE_SECONDS.min);
      expect(x.pause).toBeLessThanOrEqual(LONG_PAUSE_SECONDS.max);
    }
  });

  it("determinístico com a mesma semente; sementes diferentes divergem", () => {
    expect(run(8, 50)).toEqual(run(8, 50));
    expect(run(8, 50)).not.toEqual(run(9, 50));
  });

  it('"digitando…" é proporcional ao texto, entre 1,5 s e 8 s', () => {
    const rng = seeded(3);
    expect(typingDurationMs("oi", rng)).toBe(1500);
    expect(typingDurationMs("x".repeat(400), rng)).toBeGreaterThanOrEqual(7000);
    expect(typingDurationMs("x".repeat(4000), rng)).toBe(8000);
    const short = typingDurationMs("x".repeat(80), seeded(1));
    const long = typingDurationMs("x".repeat(240), seeded(1));
    expect(long).toBeGreaterThan(short);
  });
});

describe("disjuntor (§5.7 item 5)", () => {
  const ok = (n: number): Outcome[] => Array.from({ length: n }, () => "ok");
  const base = { channelConnected: true, providerRestriction: false } as const;

  it("canal desconectado e restrição do provedor pausam na hora", () => {
    expect(evaluateBreaker({ ...base, channelConnected: false, recent: ok(5) })).toMatchObject({ pause: true, reason: "channel_disconnected" });
    expect(evaluateBreaker({ ...base, providerRestriction: true, recent: ok(5) })).toMatchObject({ pause: true, reason: "provider_restriction" });
  });

  it("falhas: mais de 10% das últimas 20 (3 de 20 pausa; 2 de 20 não)", () => {
    const two: Outcome[] = ["failed", ...ok(10), "failed", ...ok(8)];
    expect(two).toHaveLength(20);
    expect(evaluateBreaker({ ...base, recent: two })).toEqual({ pause: false });
    const three: Outcome[] = ["failed", "failed", ...ok(5), "failed", ...ok(12)];
    expect(three).toHaveLength(20);
    expect(evaluateBreaker({ ...base, recent: three })).toMatchObject({ pause: true, reason: "high_failure_rate" });
  });

  it("poucos envios: 3 falhas seguidas no começo já pausam; 1 ou 2 não", () => {
    expect(evaluateBreaker({ ...base, recent: ["failed"] })).toEqual({ pause: false });
    expect(evaluateBreaker({ ...base, recent: ["failed", "failed", "ok"] })).toEqual({ pause: false });
    expect(evaluateBreaker({ ...base, recent: ["failed", "failed", "failed"] })).toMatchObject({ pause: true, reason: "high_failure_rate" });
  });

  it("só olha as últimas 20: falhas antigas não contam", () => {
    const recent: Outcome[] = [...ok(20), "failed", "failed", "failed", "failed"];
    expect(evaluateBreaker({ ...base, recent })).toEqual({ pause: false });
  });

  it("3 saídas/denúncias nas últimas 20 pausam; 2 não", () => {
    expect(evaluateBreaker({ ...base, recent: ["opt_out", ...ok(5), "opt_out", ...ok(5)] })).toEqual({ pause: false });
    expect(evaluateBreaker({ ...base, recent: ["opt_out", ...ok(3), "opt_out", ...ok(3), "opt_out"] })).toMatchObject({ pause: true, reason: "opt_outs" });
  });

  it("convites (§5.7 item 7): 3 recusas ou 2 falhas nas últimas 15", () => {
    expect(evaluateInviteBreaker([...ok(5), "opt_out", "opt_out"])).toBe(false);
    expect(evaluateInviteBreaker(["opt_out", ...ok(3), "opt_out", "opt_out"])).toBe(true);
    expect(evaluateInviteBreaker(["failed", ...ok(4), "failed"])).toBe(true);
    expect(evaluateInviteBreaker([...ok(15), "failed", "failed"])).toBe(false);
  });

  it("classifica falhas de envio: transitória, restrição, sem WhatsApp, comum", () => {
    expect(classifyFailure({ code: "rate_limited", message: "x" })).toBe("transient");
    expect(classifyFailure({ code: "disconnected", message: "x" })).toBe("transient");
    expect(classifyFailure({ code: "plan_paused", message: "x" })).toBe("transient");
    expect(classifyFailure({ code: "rejected", message: "Account restricted by WhatsApp" })).toBe("restriction");
    expect(classifyFailure({ code: "rejected", message: "O número foi banido" })).toBe("restriction");
    expect(classifyFailure({ code: "rejected", message: "number is not on WhatsApp" })).toBe("no_whatsapp");
    expect(classifyFailure({ code: "rejected", message: '{"exists":false}' })).toBe("no_whatsapp");
    expect(classifyFailure({ code: "unknown", message: "timeout" })).toBe("failed");
  });
});

describe("seleção de variação e texto final (§5.7 item 4)", () => {
  const bank: BankEntry[] = Array.from({ length: 12 }, (_, i) => ({ id: `v${i + 1}`, text: `texto ${i + 1}` }));

  it("nunca repete a mesma variação em mensagens seguidas e usa todas antes de repetir", () => {
    const rng = seeded(77);
    let bagIds: string[] = [];
    let last: string | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 600; i++) {
      const drawn = drawFromBag(bank, bagIds, last, rng);
      expect(drawn).not.toBeNull();
      if (!drawn) return;
      expect(drawn.entry.id).not.toBe(last);
      last = drawn.entry.id;
      bagIds = drawn.bag;
      seen.push(last);
    }
    for (let start = 0; start < 600; start += 12) expect(new Set(seen.slice(start, start + 12)).size).toBe(12);
  });

  it("ignora variações que saíram do banco aprovado e não quebra sem nenhuma", () => {
    const rng = seeded(1);
    const drawn = drawFromBag(bank.slice(0, 2), ["v9", "v10"], null, rng);
    expect(["v1", "v2"]).toContain(drawn?.entry.id);
    expect(drawFromBag([], [], null, rng)).toBeNull();
    // uma só variação: repete (não há alternativa)
    expect(drawFromBag(bank.slice(0, 1), [], "v1", rng)?.entry.id).toBe("v1");
  });

  it("a linha de saída fica sempre no fim, uma única vez", () => {
    expect(ensureOptOut("Oi!", DEFAULT_OPT_OUT_LINE)).toBe(`Oi!\n\n${DEFAULT_OPT_OUT_LINE}`);
    expect(ensureOptOut(`Oi!\n\n${DEFAULT_OPT_OUT_LINE}`, DEFAULT_OPT_OUT_LINE)).toBe(`Oi!\n\n${DEFAULT_OPT_OUT_LINE}`);
    const composed = composeBody(`Escolha:\n\n${DEFAULT_OPT_OUT_LINE}`, DEFAULT_OPT_OUT_LINE, "Responda com o número:\n1) Sim\n2) Não");
    expect(composed.endsWith(DEFAULT_OPT_OUT_LINE)).toBe(true);
    expect(composed.split(DEFAULT_OPT_OUT_LINE)).toHaveLength(2);
    expect(composed.indexOf("1) Sim")).toBeLessThan(composed.indexOf(DEFAULT_OPT_OUT_LINE));
  });

  it("botões e lista caem para opções numeradas; texto simples não ganha nada", () => {
    expect(degradeToText({ type: "text", buttons: [], listButtonLabel: "", listItems: [] })).toBeNull();
    expect(degradeToText({ type: "buttons", buttons: ["Quero", "Depois"], listButtonLabel: "", listItems: [] })).toBe("Responda com o número:\n1) Quero\n2) Depois");
    const list = degradeToText({ type: "list", buttons: [], listButtonLabel: "Ver horários", listItems: [{ title: "Manhã", description: "8h às 12h" }, { title: "Tarde", description: "" }] });
    expect(list).toBe("Ver horários (responda com o número):\n1) Manhã — 8h às 12h\n2) Tarde");
  });

  it("variáveis do contato; nome que é só telefone vira “cliente”; nenhuma chave sobra", () => {
    const vars = { name: "Carla Souza", orgName: "Casa Alvorada", lastVisit: "12/04" };
    expect(renderVariables("Oi, {nome}! {empresa} — última visita {ultima_visita}", vars)).toBe("Oi, Carla! Casa Alvorada — última visita 12/04");
    expect(firstName("+5567998123456")).toBe("cliente");
    expect(firstName("  ")).toBe("cliente");
    expect(renderVariables("{ultima_visita}", { ...vars, lastVisit: null })).toBe("recentemente");
  });
});

describe("validador de variações (código, não IA)", () => {
  const base = "Oi, {nome}! A limpeza sai por R$ 120,00 até 30/11. Agende em https://alvorada.com.br/agenda e fale com a {empresa}.";
  const good = `Olá, {nome}! Sua limpeza custa R$ 120,00 até 30/11. Marque em https://alvorada.com.br/agenda com a {empresa}.\n\n${DEFAULT_OPT_OUT_LINE}`;
  const v = (text: string, others: string[] = []) => validateVariation(base, DEFAULT_OPT_OUT_LINE, text, others);

  it("variação boa passa sem problemas", () => {
    expect(v(good)).toEqual([]);
  });

  it("preço inventado → unknown_number_or_link", () => {
    expect(v(good.replace("R$ 120,00", "R$ 99,00"))).toContain("unknown_number_or_link");
    expect(v(`${good.replace(`\n\n${DEFAULT_OPT_OUT_LINE}`, "")} Só hoje com 10% de desconto!\n\n${DEFAULT_OPT_OUT_LINE}`)).toContain("unknown_number_or_link");
  });

  it("link novo ou número novo → unknown_number_or_link; link que falta → missing_link", () => {
    expect(v(good.replace("https://alvorada.com.br/agenda", "https://golpe.example/x"))).toEqual(expect.arrayContaining(["unknown_number_or_link", "missing_link"]));
    expect(v(good.replace("https://alvorada.com.br/agenda", "o nosso site"))).toContain("missing_link");
    expect(v(good.replace("30/11", "30/12"))).toContain("unknown_number_or_link");
  });

  it("variável ausente → missing_variable", () => {
    expect(v(good.replace("{nome}", "você"))).toContain("missing_variable");
    expect(v(good.replace("{empresa}", "a clínica"))).toContain("missing_variable");
  });

  it("linha de saída ausente ou fora do fim → missing_opt_out", () => {
    expect(v(good.replace(`\n\n${DEFAULT_OPT_OUT_LINE}`, ""))).toContain("missing_opt_out");
    expect(v(`${DEFAULT_OPT_OUT_LINE}\n\n${good.replace(`\n\n${DEFAULT_OPT_OUT_LINE}`, "")}`)).toContain("missing_opt_out");
  });

  it("igual à base ou a outra variação → too_similar; muito longa/desconexa → too_different", () => {
    expect(v(`${base}\n\n${DEFAULT_OPT_OUT_LINE}`)).toContain("too_similar");
    expect(v(good, [good])).toEqual([]); // ela mesma não conta como "outra"
    expect(v(good, [good + " "])).toContain("too_similar"); // parecida demais com outra do banco
    expect(v(`Olá, {nome}! Tudo bem? Conheça o plano de seguros da {empresa} em https://alvorada.com.br/agenda. ${"Muito texto sem relação. ".repeat(8)}\n\n${DEFAULT_OPT_OUT_LINE}`)).toContain("too_different");
  });

  it("toVariations: ids únicos, tudo pendente, problemas calculados", () => {
    const list = toVariations(base, DEFAULT_OPT_OUT_LINE, [good, good.replace("{nome}", "você")]);
    expect(new Set(list.map((x) => x.id)).size).toBe(2);
    expect(list.every((x) => x.review === "pending")).toBe(true);
    expect(list[0]?.issues).toEqual([]);
    expect(list[1]?.issues).toContain("missing_variable");
  });
});

describe("gerador de demonstração e leitura da resposta da IA", () => {
  const input = { base: "Oi, {nome}! Já faz um tempinho desde a sua última limpeza. Que tal agendar um horário essa semana? Responda “quero” que a gente cuida do resto.", optOutLine: DEFAULT_OPT_OUT_LINE, count: 20 };

  it("gera a quantidade pedida, sem repetidas, e o validador acusa exatamente os defeitos propositais", () => {
    const texts = demoVariationTexts(input);
    expect(texts).toHaveLength(20);
    expect(new Set(texts).size).toBe(20);
    const variations = toVariations(input.base, input.optOutLine, texts);
    const flagged = variations.flatMap((x, i) => (x.issues.length ? [i] : []));
    expect(flagged).toEqual(expect.arrayContaining([3, 7, 11]));
    expect(variations[3]?.issues).toContain("missing_variable");
    expect(variations[7]?.issues).toContain("missing_opt_out");
    expect(variations[11]?.issues).toContain("unknown_number_or_link");
  });

  it("lê JSON puro, JSON dentro de cerca de código e lista numerada", () => {
    expect(parseVariationTexts('{"variations":["a b c d e f","g h i j k l"]}')).toEqual(["a b c d e f", "g h i j k l"]);
    expect(parseVariationTexts('```json\n["um texto", "outro texto"]\n```')).toEqual(["um texto", "outro texto"]);
    expect(parseVariationTexts("1. Primeira variação aqui\n2) Segunda variação aqui\n- terceira variação")).toEqual([
      "Primeira variação aqui",
      "Segunda variação aqui",
      "terceira variação",
    ]);
    expect(parseVariationTexts("")).toEqual([]);
  });
});

describe("público (§5.7 item 1)", () => {
  const row = (id: string, phone: string | null, consent: AudienceRow["consent"], created = 1, recent = false): AudienceRow => ({
    contactId: id,
    phone,
    consent,
    createdAt: new Date(2026, 0, created),
    recent,
  });

  it("só quem deu opt-in; saiu bloqueia; sem aceite e sem telefone ficam de fora; soma fecha com o total", () => {
    const { eligible, breakdown } = classifyAudience([
      row("a", "+5567998123456", "granted"),
      row("b", "+5567998123457", "granted", 1, true),
      row("c", "+5567998123458", "denied"),
      row("d", "+5567998123459", "none"),
      row("e", null, "granted"),
    ]);
    expect(eligible.map((r) => r.contactId).sort()).toEqual(["a", "b"]);
    expect(breakdown).toEqual({ total: 5, optedIn: 2, notOptedIn: 2, optedOut: 1, duplicates: 0, recentlyActive: 1 });
    expect(breakdown.optedIn + breakdown.notOptedIn + breakdown.optedOut + breakdown.duplicates).toBe(breakdown.total);
  });

  it("denied nunca entra, mesmo com telefone repetido de quem aceitou", () => {
    const { eligible } = classifyAudience([row("a", "+5567998123456", "denied"), row("b", "+5567998123456", "granted", 2)]);
    expect(eligible.map((r) => r.contactId)).toEqual(["b"]);
  });

  it("duplicados: o mesmo celular com e sem o 9º dígito conta uma vez (fica o mais antigo)", () => {
    expect(dedupeKey("+5567998123456")).toBe(dedupeKey("+556798123456"));
    expect(dedupeKey("+5567998123456")).not.toBe(dedupeKey("+5567998123457"));
    const { eligible, breakdown } = classifyAudience([row("novo", "+556798123456", "granted", 20), row("antigo", "+5567998123456", "granted", 2)]);
    expect(eligible.map((r) => r.contactId)).toEqual(["antigo"]);
    expect(breakdown.duplicates).toBe(1);
  });

  it("ordem embaralhada (muda com a semente), recentes primeiro e nada se perde", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, recent: i % 4 === 0 }));
    const a = orderAudience(rows, seeded(1));
    const b = orderAudience(rows, seeded(2));
    expect(a).toHaveLength(40);
    expect(new Set(a.map((r) => r.id)).size).toBe(40);
    const firstNonRecent = a.findIndex((r) => !r.recent);
    expect(a.slice(0, firstNonRecent).every((r) => r.recent)).toBe(true);
    expect(a.slice(firstNonRecent).every((r) => !r.recent)).toBe(true);
    expect(a.map((r) => r.id)).not.toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.id)).not.toEqual(rows.map((r) => r.id));
    expect(orderAudience(rows, seeded(1))).toEqual(a);
    expect([...shuffle([1, 2, 3, 4, 5], seeded(5))].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("pré-condições do disparo, incl. termos antes do primeiro envio", () => {
  const variations = Array.from({ length: 12 }, () => ({ review: "approved", issues: [] as string[] }));
  const facts: LaunchFacts = {
    status: "draft",
    termsAccepted: true,
    audienceId: "aud",
    eligibleRecipients: 30,
    channel: { connected: true, kind: "whatsapp_qr" },
    message: { body: "Oi, {nome}! Temos novidades na {empresa}.", optOutLine: DEFAULT_OPT_OUT_LINE, type: "text" },
    template: null,
    variationsBase: "Oi, {nome}! Temos novidades na {empresa}.",
    variations,
    windowStart: "08:00",
    windowEnd: "20:00",
    scheduleMode: "now",
    scheduledAt: null,
    now: new Date("2026-10-26T15:00:00Z"),
  };
  const err = (patch: Partial<LaunchFacts>) => {
    const r = checkLaunch({ ...facts, ...patch });
    return r.ok ? null : r.error;
  };

  it("caminho feliz", () => {
    expect(checkLaunch(facts)).toEqual({ ok: true });
  });

  it("termos não aceitos barram o disparo (e só depois dos demais checks de estado)", () => {
    expect(err({ termsAccepted: false })).toBe("terms_required");
    expect(err({ termsAccepted: false, status: "sending" })).toBe("not_draft");
  });

  it("sem público elegível, canal fora do ar, janela e agendamento inválidos", () => {
    expect(err({ eligibleRecipients: 0 })).toBe("no_audience");
    expect(err({ audienceId: null })).toBe("no_audience");
    expect(err({ channel: { connected: false, kind: "whatsapp_qr" } })).toBe("channel_unavailable");
    expect(err({ channel: null })).toBe("channel_unavailable");
    expect(err({ windowStart: "20:00", windowEnd: "08:00" })).toBe("invalid_window");
    expect(err({ scheduleMode: "scheduled", scheduledAt: new Date("2026-10-20T10:00:00Z") })).toBe("invalid_schedule");
    expect(err({ scheduleMode: "scheduled", scheduledAt: null })).toBe("invalid_schedule");
    expect(err({ scheduleMode: "scheduled", scheduledAt: new Date("2026-11-03T12:00:00Z") })).toBeNull();
  });

  it("QR: base mudou, menos de 10 aprovadas, pendente, aprovada com problema, variável desconhecida, sem linha de saída", () => {
    expect(err({ variationsBase: "outra" })).toBe("variations_required");
    expect(err({ variations: variations.slice(0, 9) })).toBe("variations_required");
    expect(err({ variations: [...variations, { review: "pending", issues: [] }] })).toBe("variations_required");
    expect(err({ variations: [...variations.slice(0, 9), { review: "approved", issues: ["missing_variable"] }] })).toBe("variations_required");
    expect(err({ message: { ...facts.message, body: "Oi {cidade}" }, variationsBase: "Oi {cidade}" })).toBe("invalid_message");
    expect(err({ message: { ...facts.message, optOutLine: "Obrigado." } })).toBe("invalid_message");
    expect(err({ message: { ...facts.message, body: "  " }, variationsBase: "  " })).toBe("invalid_message");
  });

  it("API oficial: só modelo aprovado pela Meta (com saída), sem exigir variações", () => {
    const official = { channel: { connected: true, kind: "whatsapp_official" as const }, variations: [], variationsBase: null };
    expect(err({ ...official, template: null })).toBe("template_required");
    expect(err({ ...official, template: { metaStatus: "pending", body: "Responda SAIR" } })).toBe("template_required");
    expect(err({ ...official, template: { metaStatus: "approved", body: "Promoção sem saída" } })).toBe("template_required");
    expect(err({ ...official, template: { metaStatus: "approved", body: "Promoção! Responda SAIR para parar." } })).toBeNull();
  });
});

describe("apresentação", () => {
  it("telefone mascarado", () => {
    expect(maskPhone("+5567998123456")).toBe("+55 67 9••••-3456");
    expect(maskPhone("+556798123456")).toBe("+55 67 ••••-3456");
    expect(maskPhone(null)).toBe("—");
  });
});
