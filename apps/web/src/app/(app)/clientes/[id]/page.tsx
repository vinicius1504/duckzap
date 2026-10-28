import { isSendingPaused } from "@duckzap/contracts/session";
import { Card } from "@duckzap/ui/components/card";
import { Icon } from "@duckzap/ui/components/icon";
import { Page } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/features/auth/session";
import { getContact, getInviteOverview, listContactOwners, listTags } from "@/features/contacts/api";
import { ContactProfile } from "@/features/contacts/components/contact-profile";
import { contactPerms } from "@/features/contacts/perms";
import { loadProfileAppointments } from "@/features/contacts/profile-data";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const contact = await getContact((await params).id);
  return { title: contact ? `${contact.name} · Clientes` : "Clientes" };
}

export default async function ContactPage({ params }: Props) {
  const session = await requireSession();
  const { id } = await params;
  const [contact, tags, owners, inviteOverview, appointments] = await Promise.all([
    getContact(id),
    listTags(),
    listContactOwners(),
    getInviteOverview(),
    loadProfileAppointments(id),
  ]);
  if (!contact) notFound();

  return (
    <Page>
      <Link href="/clientes" className="inline-flex min-h-11 items-center gap-2 self-start font-semibold text-ink-2 hover:text-ink">
        <Icon name="arrowLeft" size={18} />
        Clientes
      </Link>
      <Card className="mx-auto w-full max-w-3xl p-6 max-sm:p-4">
        <ContactProfile
          contact={contact}
          tags={tags}
          owners={owners}
          appointments={appointments}
          inviteOverview={inviteOverview}
          perms={contactPerms(session.user.role)}
          sendingPaused={isSendingPaused(session)}
          timeZone={session.organization.timeZone}
          variant="page"
        />
      </Card>
    </Page>
  );
}
