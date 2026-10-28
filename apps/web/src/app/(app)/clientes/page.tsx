import { isSendingPaused } from "@duckzap/contracts/session";
import { Card } from "@duckzap/ui/components/card";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import { requireSession } from "@/features/auth/session";
import {
  getContact,
  getInviteOverview,
  listContactLists,
  listContactOwners,
  listContacts,
  listTags,
  listWhatsappImportChannels,
} from "@/features/contacts/api";
import { ContactDrawer } from "@/features/contacts/components/contact-drawer";
import { ContactsTable } from "@/features/contacts/components/contacts-table";
import { ContactsToolbar } from "@/features/contacts/components/contacts-toolbar";
import { ContactsHeaderActions, ContactsTabs } from "@/features/contacts/components/header-actions";
import { ListsTab } from "@/features/contacts/components/lists-tab";
import { TagsTab } from "@/features/contacts/components/tags-tab";
import { contactPerms } from "@/features/contacts/perms";
import { loadProfileAppointments } from "@/features/contacts/profile-data";
import { filterFromQuery, hasActiveFilters, parseContactsSearch, type RawSearchParams } from "@/features/contacts/search-params";

export const metadata: Metadata = { title: "Clientes" };

export default async function ContactsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await requireSession();
  const { tab, query, contactId } = parseContactsSearch(await searchParams);
  const perms = contactPerms(session.user.role);
  const sendingPaused = isSendingPaused(session);
  const timeZone = session.organization.timeZone;

  const [tags, lists, owners, inviteOverview, page, detail, whatsappChannels] = await Promise.all([
    listTags(),
    listContactLists(),
    listContactOwners(),
    getInviteOverview(),
    listContacts(tab === "todos" ? query : { page: 1, pageSize: 1 }),
    contactId ? getContact(contactId) : Promise.resolve(null),
    perms.import ? listWhatsappImportChannels() : Promise.resolve(null),
  ]);
  const profileAppointments = detail ? await loadProfileAppointments(detail.id) : [];
  const activeList = query.listId ? (lists.find((l) => l.id === query.listId) ?? null) : null;
  const { page: _page, pageSize: _size, ...exportQuery } = query;
  const filtered = hasActiveFilters(query);

  return (
    <Page className="gap-[18px]">
      <PageHeader
        title="Clientes"
        description={`${page.overall.contacts.toLocaleString("pt-BR")} pessoas · ${page.overall.granted.toLocaleString("pt-BR")} aceitam receber campanhas`}
        actions={
          <ContactsHeaderActions
            tags={tags}
            lists={lists}
            owners={owners}
            inviteOverview={inviteOverview}
            whatsappChannels={whatsappChannels}
            exportQuery={exportQuery}
            perms={perms}
            sendingPaused={sendingPaused}
          />
        }
      />
      {sendingPaused ? (
        <Alert tone="warn" title="Plano expirado">
          Você pode ver e editar clientes, mas convites e campanhas estão pausados até regularizar o plano.
        </Alert>
      ) : null}

      <ContactsTabs tab={tab}>
        {tab === "todos" ? (
          <div className="flex flex-col gap-3">
            <ContactsToolbar tags={tags} activeList={activeList} currentFilter={filterFromQuery(query)} />
            {page.total === 0 ? (
              <Card>
                {filtered ? (
                  <EmptyState
                    icon="search"
                    title="Nenhum cliente com esses filtros"
                    description="Tente outra busca ou limpe os filtros."
                  />
                ) : (
                  <EmptyState
                    icon="contacts"
                    title="Nenhum cliente ainda"
                    description="Importe do WhatsApp ou de uma planilha, ou cadastre o primeiro cliente. Quem conversar com a sua empresa também aparece aqui."
                  />
                )}
              </Card>
            ) : (
              <ContactsTable
                key={JSON.stringify(query)}
                page={page}
                tags={tags}
                lists={lists}
                inviteOverview={inviteOverview}
                perms={perms}
                sendingPaused={sendingPaused}
                timeZone={timeZone}
              />
            )}
          </div>
        ) : null}
        {tab === "listas" ? <ListsTab lists={lists} tags={tags} perms={perms} /> : null}
        {tab === "etiquetas" ? <TagsTab tags={tags} perms={perms} /> : null}
      </ContactsTabs>

      {detail ? (
        <ContactDrawer
          key={detail.id}
          contact={detail}
          tags={tags}
          owners={owners}
          appointments={profileAppointments}
          inviteOverview={inviteOverview}
          perms={perms}
          sendingPaused={sendingPaused}
          timeZone={timeZone}
        />
      ) : null}
    </Page>
  );
}
