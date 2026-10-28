// Teste manual de "Importar do WhatsApp" contra a Evolution local (EVOLUTION_URL/EVOLUTION_API_KEY do .env):
// `pnpm --filter @duckzap/api whatsapp:smoke [nomeDaInstância]`. Só LÊ (findContacts). Imprime APENAS contagens:
// nunca nomes, números, JIDs nem chaves. Sem nome de instância, usa a primeira conectada.
import { loadChannelsConfig } from "../src/modules/channels/config";
import { EvolutionProvider } from "../src/modules/channels/providers/evolution";
import { asRecord, asString } from "../src/modules/channels/providers/shared";
import { buildWhatsappCandidates } from "../src/modules/contacts/whatsapp-import";

const config = loadChannelsConfig();
if (!config.evolutionApiKey) throw new Error("Defina EVOLUTION_API_KEY no .env.");

const listed = await fetch(`${config.evolutionUrl}/instance/fetchInstances`, { headers: { apikey: config.evolutionApiKey } });
const instances: unknown = await listed.json().catch(() => null);
const all = (Array.isArray(instances) ? instances : []).map(asRecord);
console.log(`Instâncias na Evolution: ${all.length} (conectadas: ${all.filter((i) => i.connectionStatus === "open").length})`);

const wanted = process.argv[2];
const chosen = all.find((i) => (wanted ? i.name === wanted : i.connectionStatus === "open"));
const instanceName = asString(chosen?.name);
if (!chosen || !instanceName) throw new Error(wanted ? "Instância não encontrada." : "Nenhuma instância conectada.");
const own = asString(chosen.ownerJid)?.split("@")[0];
const ownPhone = own ? `+${own.replace(/\D/g, "")}` : null;

const provider = new EvolutionProvider({ baseUrl: config.evolutionUrl, apiKey: config.evolutionApiKey });
const started = Date.now();
const contacts = await provider.listContacts({ id: "smoke", organizationId: "smoke", credentials: { instanceName } });
console.log(`findContacts: ${contacts.length} itens em ${Date.now() - started} ms`);

const count = (pick: (c: (typeof contacts)[number]) => boolean) => contacts.filter(pick).length;
console.log("Por tipo:", { person: count((c) => c.kind === "person"), group: count((c) => c.kind === "group"), hidden: count((c) => c.kind === "hidden"), other: count((c) => c.kind === "other") });
const persons = contacts.filter((c) => c.kind === "person");
const lengths: Record<string, number> = {};
for (const p of persons) lengths[String(p.phoneDigits?.length)] = (lengths[String(p.phoneDigits?.length)] ?? 0) + 1;
console.log("Pessoas por nº de dígitos:", lengths);
console.log("Pessoas com nome útil:", persons.filter((p) => p.name).length, "| sem nome útil:", persons.filter((p) => !p.name).length);

const built = buildWhatsappCandidates(contacts, ownPhone);
console.log("Candidatos finais:", built.candidates.length, "| sem nome:", built.candidates.filter((c) => !c.name).length);
console.log("Fora da lista:", { groups: built.groups, hidden: built.hidden, other: built.other });
