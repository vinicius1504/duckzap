"use client";

import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Alert } from "@duckzap/ui/components/feedback";
import { Textarea } from "@duckzap/ui/components/form-controls";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { useRef, useState, useTransition } from "react";
import { createSupportTicketAction } from "../actions";
import { isRealLink } from "./links";

export function SupportForm({ hours, whatsappUrl }: { hours: string; whatsappUrl: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<string | null>(null);

  function submit(formData: FormData) {
    const input = { subject: String(formData.get("subject") ?? ""), message: String(formData.get("message") ?? "") };
    startTransition(async () => {
      const result = await createSupportTicketAction(input);
      if (result.ok) {
        setError(null);
        setProtocol(result.data.protocol);
        formRef.current?.reset();
      } else {
        setProtocol(null);
        setError(result.error);
      }
    });
  }

  return (
    <Card className="p-[22px]">
      <CardTitle>Falar com o suporte</CardTitle>
      <form ref={formRef} action={submit} className="mt-3 flex flex-col gap-3" noValidate>
        <div>
          <Label htmlFor="suporte-assunto">Assunto</Label>
          <Input id="suporte-assunto" name="subject" maxLength={120} required className="h-10" />
        </div>
        <div>
          <Label htmlFor="suporte-mensagem">Conte o que aconteceu</Label>
          <Textarea
            id="suporte-mensagem"
            name="message"
            rows={4}
            maxLength={4000}
            required
            aria-describedby={error ? "suporte-erro" : undefined}
          />
          <FieldError id="suporte-erro" message={error ?? undefined} />
        </div>
        {protocol ? (
          <Alert tone="ok" live>
            Recebemos sua mensagem (protocolo {protocol}). Respondemos por e-mail.
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Enviando…" : "Enviar"}
          </Button>
          {isRealLink(whatsappUrl) ? (
            <a href={whatsappUrl} target="_blank" rel="noreferrer" className={buttonVariants()}>
              Chamar no WhatsApp
            </a>
          ) : (
            <Button disabled title="Link do WhatsApp do suporte ainda não definido">
              Chamar no WhatsApp
            </Button>
          )}
        </div>
        <p className="text-xs text-ink-2">{hours}</p>
      </form>
    </Card>
  );
}
