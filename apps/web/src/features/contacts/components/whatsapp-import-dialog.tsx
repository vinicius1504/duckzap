"use client";

import type { ContactList, ImportResult, Tag, WhatsappCandidate, WhatsappImportPreview } from "@duckzap/contracts/contacts";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert, EmptyState, Spinner } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Input, Label } from "@duckzap/ui/components/input";
import { Steps } from "@duckzap/ui/components/layout";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { formatPhone } from "@/lib/format";
import {
  NAME_MAX_LENGTH,
  buildCommitRows,
  displayName,
  exclusionText,
  filterCandidates,
  foundHeadline,
  initialSelection,
  pluralize,
  selectionStats,
  setMany,
  sortCandidates,
} from "@/lib/whatsapp-import";
import { commitWhatsappImportAction, previewWhatsappImportAction } from "../actions";
import type { WhatsappImportChannel } from "../api";
import { ImportOriginFields, emptyOriginFields, type OriginFields } from "./import-origin-fields";
import { ImportResultStep } from "./import-result";

const steps = ["Canal", "Revisar", "Origem", "Pronto"] as const;

/** Linhas mostradas por vez na revisão (a lista pode ter milhares; "Mostrar mais" libera o resto). */
const PAGE_SIZE = 100;

const channelStatusLabel: Record<WhatsappImportChannel["status"], string> = {
  connected: "Conectado",
  qr_pending: "Aguardando a leitura do QR code",
  awaiting_authorization: "Aguardando autorização",
  disconnected: "Desconectado",
  banned: "Bloqueado pelo WhatsApp",
};

const searchFailed = "Não conseguimos buscar os contatos agora. Tente de novo em instantes.";

/** Uma linha da revisão. Memoizada: digitar um nome não redesenha as outras 99. */
const ReviewRow = memo(function ReviewRow({
  candidate,
  checked,
  name,
  onToggle,
  onRename,
}: {
  candidate: WhatsappCandidate;
  checked: boolean;
  name: string;
  onToggle: (phone: string, checked: boolean) => void;
  onRename: (phone: string, name: string) => void;
}) {
  const noName = name.trim() === "";
  const phone = formatPhone(candidate.phone);
  return (
    <tr className={noName ? "bg-warn-bg" : undefined}>
      <Td className="w-12 px-1">
        <label className="flex size-11 cursor-pointer items-center justify-center">
          <Checkbox checked={checked} aria-label={`Importar ${name.trim() || phone}`} onChange={(e) => onToggle(candidate.phone, e.target.checked)} />
        </label>
      </Td>
      <Td>
        <Input
          aria-label={`Nome de ${phone}`}
          value={name}
          maxLength={NAME_MAX_LENGTH}
          placeholder="Sem nome — escreva um"
          className={noName ? "border-warn" : undefined}
          onChange={(e) => onRename(candidate.phone, e.target.value)}
        />
      </Td>
      <Td className="whitespace-nowrap text-ink-2">{phone}</Td>
      <Td>{candidate.existing ? <Chip tone="info">Já cadastrado</Chip> : null}</Td>
    </tr>
  );
});

/** "Importar do WhatsApp": busca os contatos do número conectado, a pessoa revisa e corrige, e termina como a planilha. */
export function WhatsappImportDialog({
  open,
  onOpenChange,
  tags,
  lists,
  channels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: Tag[];
  lists: ContactList[];
  /** Canais WhatsApp por QR da empresa; `null` quando a lista não carregou. */
  channels: WhatsappImportChannel[] | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error">("idle");
  const [searchChannelId, setSearchChannelId] = useState<string | null>(null);
  const [preview, setPreview] = useState<WhatsappImportPreview | null>(null);
  const [candidates, setCandidates] = useState<WhatsappCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [fields, setFields] = useState<OriginFields>(emptyOriginFields);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /** Número da busca em andamento: respostas de buscas antigas (ou de um diálogo já fechado) são descartadas. */
  const requestRef = useRef(0);
  const autoStartedRef = useRef(false);
  const focusRef = useRef<HTMLElement | null>(null);

  const connected = (channels ?? []).filter((c) => c.status === "connected");

  function reset() {
    requestRef.current += 1;
    setStep(0);
    setSearchState("idle");
    setSearchChannelId(null);
    setPreview(null);
    setCandidates([]);
    setSelected(new Set());
    setEdits({});
    setQuery("");
    setShown(PAGE_SIZE);
    setFields(emptyOriginFields);
    setResult(null);
    setError(null);
  }

  function change(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function search(channelId: string) {
    const request = ++requestRef.current;
    setSearchChannelId(channelId);
    setSearchState("loading");
    setError(null);
    let res: Awaited<ReturnType<typeof previewWhatsappImportAction>>;
    try {
      res = await previewWhatsappImportAction(channelId);
    } catch {
      res = { error: searchFailed };
    }
    if (request !== requestRef.current) return;
    if ("error" in res) {
      setError(res.error);
      setSearchState("error");
      return;
    }
    setPreview(res.data);
    setCandidates(sortCandidates(res.data.candidates));
    setSelected(initialSelection(res.data.candidates));
    setEdits({});
    setQuery("");
    setShown(PAGE_SIZE);
    setSearchState("idle");
    setStep(1);
  }

  // Com um único número conectado não há o que escolher: já começa a buscar ao abrir.
  useEffect(() => {
    if (!open) {
      autoStartedRef.current = false;
      return;
    }
    const only = connected.length === 1 ? connected[0] : undefined;
    if (only && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void search(only.id);
    }
    // só reage à abertura do diálogo
  }, [open]);

  // Leitor de tela e teclado: ao trocar de passo/estado, o foco vai para o título do que está na tela.
  useEffect(() => {
    if (open) focusRef.current?.focus();
  }, [open, step, searchState]);

  const filtered = useMemo(() => filterCandidates(candidates, query), [candidates, query]);
  const visible = filtered.slice(0, shown);
  const stats = useMemo(() => selectionStats(candidates, selected, edits), [candidates, selected, edits]);
  const filteredSelected = useMemo(() => filtered.reduce((n, c) => n + (selected.has(c.phone) ? 1 : 0), 0), [filtered, selected]);
  const hasNoNameShown = visible.some((c) => displayName(c, edits).trim() === "");
  const existingCount = useMemo(() => candidates.reduce((n, c) => n + (c.existing ? 1 : 0), 0), [candidates]);
  const filteredPhones = useMemo(() => filtered.map((c) => c.phone), [filtered]);

  const toggle = useCallback((phone: string, checked: boolean) => setSelected((s) => setMany(s, [phone], checked)), []);
  const rename = useCallback((phone: string, name: string) => setEdits((e) => ({ ...e, [phone]: name })), []);

  function commit() {
    if (!preview || !fields.origin) return;
    const built = buildCommitRows(candidates, selected, edits);
    if (!built.ok) return setError(built.error);
    const origin = fields.origin;
    setError(null);
    startTransition(async () => {
      if (!fields.confirmed) return setError("Confirme a relação com a sua empresa para importar.");
      const res = await commitWhatsappImportAction({
        importId: preview.importId,
        rows: built.rows,
        origin,
        originNote: fields.originNote,
        confirmedRelationship: true,
        tagIds: fields.tagIds,
        listId: fields.listId || null,
      });
      if ("error" in res) return setError(res.error);
      setResult(res.data);
      setStep(3);
      router.refresh();
    });
  }

  const headingClass = "text-base font-bold outline-none";

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent size="lg" title="Importar do WhatsApp" description="Traga os contatos que já estão no WhatsApp do seu número. Você confere tudo antes de importar.">
        <Steps steps={steps} current={step} label="Etapas da importação" />

        {step === 0 ? (
          <div className="flex flex-col gap-4">
            {searchState === "loading" ? (
              <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                <Spinner size={28} />
                <h3 ref={(el) => void (focusRef.current = el)} tabIndex={-1} className={headingClass}>
                  Buscando os contatos do WhatsApp…
                </h3>
                <p className="max-w-sm text-ink-2">Pode levar alguns segundos. Não feche esta janela.</p>
              </div>
            ) : (
              <>
                <h3 ref={(el) => void (focusRef.current = el)} tabIndex={-1} className={headingClass}>
                  Escolha o número do WhatsApp
                </h3>
                {channels === null ? (
                  <Alert
                    tone="warn"
                    action={
                      <Link href="/canais" className={buttonVariants({ size: "sm" })}>
                        Abrir Canais
                      </Link>
                    }
                  >
                    Não conseguimos carregar seus números agora. Feche esta janela e tente de novo.
                  </Alert>
                ) : channels.length === 0 ? (
                  <EmptyState
                    icon="qr"
                    title="Nenhum WhatsApp conectado por QR code"
                    description="Para trazer os contatos do WhatsApp, conecte seu número por QR code em Canais."
                    action={
                      <Link href="/canais" className={buttonVariants({ variant: "primary" })}>
                        Ir para Canais
                      </Link>
                    }
                  />
                ) : (
                  <ul className="flex flex-col gap-2">
                    {channels.map((channel) => {
                      const isConnected = channel.status === "connected";
                      const number = channel.address ? formatPhone(channel.address) : "Número ainda não identificado";
                      return (
                        <li key={channel.id}>
                          {isConnected ? (
                            <button
                              type="button"
                              onClick={() => void search(channel.id)}
                              className="flex min-h-14 w-full items-center gap-3 rounded-control border border-field bg-surface px-3.5 py-2 text-left hover:bg-surface-hover"
                            >
                              <Icon name="phone" size={20} className="shrink-0 text-ink-2" />
                              <span className="min-w-0 flex-1">
                                <strong className="block truncate">{channel.name}</strong>
                                <span className="block text-[13px] text-ink-2">{number}</span>
                              </span>
                              <Chip tone="ok">{channelStatusLabel[channel.status]}</Chip>
                            </button>
                          ) : (
                            <div className="flex min-h-14 flex-wrap items-center gap-3 rounded-control border border-line bg-surface-2 px-3.5 py-2">
                              <Icon name="phone" size={20} className="shrink-0 text-ink-2" />
                              <span className="min-w-0 flex-1">
                                <strong className="block truncate text-ink-2">{channel.name}</strong>
                                <span className="block text-[13px] text-ink-2">
                                  {channelStatusLabel[channel.status]}. Reconecte em{" "}
                                  <Link href="/canais" className="font-semibold text-ink underline">
                                    Canais
                                  </Link>{" "}
                                  para importar.
                                </span>
                              </span>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {searchState === "error" && error ? (
                  <Alert
                    tone="err"
                    live
                    action={
                      searchChannelId ? (
                        <Button size="sm" onClick={() => void search(searchChannelId)}>
                          Tentar de novo
                        </Button>
                      ) : undefined
                    }
                  >
                    {error}
                  </Alert>
                ) : null}
              </>
            )}
            <DialogFooter>
              <Button onClick={() => change(false)}>Cancelar</Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 1 && preview ? (
          <div className="flex flex-col gap-3">
            <div>
              <h3 ref={(el) => void (focusRef.current = el)} tabIndex={-1} className={headingClass}>
                {foundHeadline(preview.summary)}
              </h3>
              <p className="text-[13px] text-ink-2">No WhatsApp “{preview.channelName}”. Confira os nomes: corrija o que estiver errado ou incompleto.</p>
            </div>
            {exclusionText(preview.summary) ? <Alert tone="info">{exclusionText(preview.summary)}</Alert> : null}
            {existingCount > 0 ? (
              <p className="text-[13px] text-ink-2">
                Quem já é cliente começa desmarcado. Se marcar, só entram a etiqueta e a lista que você escolher: ninguém é duplicado.
              </p>
            ) : null}

            {candidates.length === 0 ? (
              <Alert tone="warn">O WhatsApp deste número não trouxe nenhuma pessoa com número visível. Volte e tente outro número.</Alert>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-48 flex-1">
                    <Label htmlFor="wa-busca">Buscar por nome ou telefone</Label>
                    <Input
                      id="wa-busca"
                      type="search"
                      value={query}
                      placeholder="Ex.: Maria ou 99812"
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setShown(PAGE_SIZE);
                      }}
                    />
                  </div>
                  <Button className="max-md:h-11" disabled={filtered.length === 0 || filteredSelected === filtered.length} onClick={() => setSelected((s) => setMany(s, filteredPhones, true))}>
                    {query.trim() ? `Marcar os ${filtered.length.toLocaleString("pt-BR")} da busca` : "Marcar todos"}
                  </Button>
                  <Button className="max-md:h-11" disabled={filteredSelected === 0} onClick={() => setSelected((s) => setMany(s, filteredPhones, false))}>
                    {query.trim() ? "Desmarcar os da busca" : "Desmarcar todos"}
                  </Button>
                </div>
                <p aria-live="polite" className="text-[13px] font-semibold">
                  {stats.selected.toLocaleString("pt-BR")} de {candidates.length.toLocaleString("pt-BR")} marcados
                </p>
                {hasNoNameShown ? (
                  <p className="text-[13px] text-warn">Linhas em destaque estão sem nome. Escreva um ou deixe como “Sem nome”.</p>
                ) : null}

                {filtered.length === 0 ? (
                  <p className="rounded-control border border-line px-4 py-8 text-center text-ink-2">Ninguém encontrado para “{query.trim()}”.</p>
                ) : (
                  <>
                    <div className="max-h-[50dvh] overflow-y-auto rounded-card">
                      <Table minWidth={560}>
                        <thead>
                          <tr>
                            <Th className="w-12 px-1">
                              <span className="sr-only">Importar</span>
                            </Th>
                            <Th>Nome (pode corrigir)</Th>
                            <Th>Telefone</Th>
                            <Th>
                              <span className="sr-only">Situação</span>
                            </Th>
                          </tr>
                        </thead>
                        <tbody>
                          {visible.map((candidate) => (
                            <ReviewRow
                              key={candidate.phone}
                              candidate={candidate}
                              checked={selected.has(candidate.phone)}
                              name={displayName(candidate, edits)}
                              onToggle={toggle}
                              onRename={rename}
                            />
                          ))}
                        </tbody>
                      </Table>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-2">
                      <span>
                        Mostrando {visible.length.toLocaleString("pt-BR")} de {filtered.length.toLocaleString("pt-BR")}
                      </span>
                      {visible.length < filtered.length ? (
                        <Button size="sm" className="max-md:h-11" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                          Mostrar mais {Math.min(PAGE_SIZE, filtered.length - visible.length).toLocaleString("pt-BR")}
                        </Button>
                      ) : null}
                    </div>
                  </>
                )}
              </>
            )}

            {stats.selectedWithoutName > 0 ? (
              <p className="text-[13px] text-ink-2">
                {pluralize(stats.selectedWithoutName, "marcado está sem nome e entra", "marcados estão sem nome e entram")} como “Sem nome”.
              </p>
            ) : null}
            <DialogFooter>
              <Button onClick={() => setStep(0)}>Voltar</Button>
              <Button variant="primary" disabled={stats.selected === 0} onClick={() => setStep(2)}>
                Continuar
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 2 && preview ? (
          <div className="flex flex-col gap-4">
            <h3 ref={(el) => void (focusRef.current = el)} tabIndex={-1} className={headingClass}>
              De onde vieram estes contatos?
            </h3>
            <ImportOriginFields
              idPrefix="wa-imp"
              tags={tags}
              lists={lists}
              value={fields}
              onChange={(patch) => setFields((f) => ({ ...f, ...patch }))}
              showError={Boolean(error)}
            />
            {error ? (
              <Alert tone="err" live>
                {error}
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                onClick={() => {
                  setError(null);
                  setStep(1);
                }}
              >
                Voltar
              </Button>
              <Button variant="primary" disabled={pending || !fields.origin || !fields.confirmed} onClick={commit}>
                {pending ? "Importando…" : `Importar ${pluralize(stats.selected, "contato", "contatos")}`}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 3 && result ? (
          <div ref={(el) => void (focusRef.current = el)} tabIndex={-1} className="outline-none">
            <ImportResultStep result={result} rowLabel="Contato" onClose={() => change(false)} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
