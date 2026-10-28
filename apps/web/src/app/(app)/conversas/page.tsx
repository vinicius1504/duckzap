import type { ConversationSummary, InboxFilters, InboxTab } from "@duckzap/contracts/conversations";
import { can } from "@duckzap/contracts/permissions";
import { isSendingPaused } from "@duckzap/contracts/session";
import { buttonVariants } from "@duckzap/ui/components/button";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { cn } from "@duckzap/ui/cn";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/features/auth/session";
import { getConversation, getInboxLookups, listConversations, type Viewer } from "@/features/conversations/api";
import { ConversationList } from "@/features/conversations/components/conversation-list";
import { ConversationView } from "@/features/conversations/components/conversation-view";
import { InboxToolbar } from "@/features/conversations/components/inbox-toolbar";
import { KanbanBoard } from "@/features/conversations/components/kanban-board";
import type { InboxPermissions } from "@/features/conversations/components/view-model";
import {
  inboxHref,
  inboxSearchSchema,
  TAB_SLUGS,
  tabFromSlug,
  type TabSlug,
} from "@/features/conversations/search-params";

export const metadata: Metadata = { title: "Conversas" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ConversationsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireSession();
  const role = session.user.role;
  const permissions: InboxPermissions = {
    reply: can(role, "conversation.reply"),
    assign: can(role, "conversation.assign"),
    transfer: can(role, "conversation.transfer"),
    viewAll: can(role, "conversation.view_all"),
    editContact: can(role, "contact.edit"),
    manageAppointments: can(role, "appointment.manage"),
  };
  const viewer: Viewer = { id: session.user.id, canViewAll: permissions.viewAll };
  const tabs: readonly TabSlug[] = TAB_SLUGS;

  const raw = await searchParams;
  // link antigo (?cliente=<id>): a conversa com o cliente é aberta/criada pelo botão "Abrir conversa" da ficha (um GET não cria nada)
  if (typeof raw.cliente === "string" && /^[0-9a-f-]{36}$/i.test(raw.cliente)) redirect(`/clientes/${raw.cliente}`);
  const search = inboxSearchSchema.parse(raw);
  // sem view_all a aba "Todas" não existe: cai em "Minhas"
  const tab: TabSlug = tabs.includes(search.aba) ? search.aba : "minhas";

  const query = new URLSearchParams();
  const urlEntries: [string, string | undefined][] = [
    ["aba", tab === "minhas" ? undefined : tab],
    ["visao", search.visao === "lista" ? undefined : search.visao],
    ["conversa", search.conversa],
    ["canal", search.canal],
    ["equipe", search.equipe],
    ["etiqueta", search.etiqueta],
    ["prioridade", search.prioridade],
    ["busca", search.busca],
  ];
  for (const [key, value] of urlEntries) if (value) query.set(key, value);
  const queryString = query.toString();

  const filters: InboxFilters = {
    tab: tabFromSlug[tab],
    channelId: search.canal ?? null,
    teamId: search.equipe ?? null,
    tagId: search.etiqueta ?? null,
    priority: search.prioridade ?? null,
    search: search.busca ?? null,
  };
  const hasFilters = Boolean(search.canal || search.equipe || search.etiqueta || search.prioridade || search.busca);
  const isBoard = search.visao === "quadro";
  const tz = session.organization.timeZone;
  const nowIso = new Date().toISOString();
  const sendingPausedReason = isSendingPaused(session)
    ? "Seu plano expirou: você ainda lê as conversas, mas responder clientes fica pausado até renovar."
    : null;

  const [lookups, list, detail, boardItems] = await Promise.all([
    getInboxLookups(),
    listConversations(filters, viewer),
    !isBoard && search.conversa ? getConversation(search.conversa, viewer) : Promise.resolve(null),
    isBoard ? boardConversations(filters, viewer) : Promise.resolve([]),
  ]);

  const selectedId = isBoard ? null : (search.conversa ?? null);
  // altura da área útil: tela − topo (4rem) − faixa de plano expirado − tab bar no celular (5rem)
  const height = sendingPausedReason
    ? "md:h-[calc(100dvh-6.75rem)] max-md:h-[calc(100dvh-11.75rem)]"
    : "md:h-[calc(100dvh-4rem)] max-md:h-[calc(100dvh-9rem)]";

  return (
    <main className={cn("flex min-h-[480px] flex-col", height)}>
      <InboxToolbar lookups={lookups} className={cn(selectedId && "max-md:hidden")} />

      {isBoard ? (
        <KanbanBoard
          items={boardItems}
          lookups={lookups}
          canMove={permissions.editContact}
          query={queryString}
          nowIso={nowIso}
          timeZone={tz}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <section
            aria-label="Lista de conversas"
            className={cn(
              "flex w-[340px] shrink-0 flex-col border-r border-line bg-surface max-lg:w-[300px] max-md:w-full max-md:border-r-0",
              selectedId && "max-md:hidden",
            )}
          >
            <ConversationList
              list={list}
              lookups={lookups}
              tab={tab}
              tabs={tabs}
              selectedId={selectedId}
              query={queryString}
              nowIso={nowIso}
              timeZone={tz}
              hasFilters={hasFilters}
            />
          </section>

          <div className={cn("flex min-h-0 min-w-0 flex-1", !selectedId && "max-md:hidden")}>
            {detail ? (
              <ConversationView
                key={detail.conversation.id}
                detail={detail}
                lookups={lookups}
                permissions={permissions}
                viewer={{ id: session.user.id, name: session.user.name }}
                sendingPausedReason={sendingPausedReason}
                query={queryString}
                nowIso={nowIso}
                timeZone={tz}
              />
            ) : (
              <div className="m-auto">
                {selectedId ? (
                  <EmptyState
                    icon="alert"
                    title="Conversa não encontrada"
                    description="Ela pode ter sido transferida para outra pessoa ou você não tem acesso a ela."
                    action={
                      <Link href={inboxHref(queryString, { conversation: null })} className={buttonVariants({ size: "sm" })}>
                        Voltar para a lista
                      </Link>
                    }
                  />
                ) : (
                  <EmptyState
                    icon="chat"
                    title="Escolha uma conversa"
                    description="Selecione uma conversa na lista para ver as mensagens e responder."
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

/** O quadro mostra tudo o que a pessoa pode ver (abertas e resolvidas), com os mesmos filtros. */
async function boardConversations(filters: InboxFilters, viewer: Viewer): Promise<ConversationSummary[]> {
  const tabs: InboxTab[] = viewer.canViewAll ? ["all", "resolved"] : ["mine", "waiting", "ai", "resolved"];
  const lists = await Promise.all(tabs.map((tab) => listConversations({ ...filters, tab }, viewer)));
  const byId = new Map<string, ConversationSummary>();
  for (const list of lists) for (const c of list.items) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.lastMessage.at.localeCompare(a.lastMessage.at));
}
