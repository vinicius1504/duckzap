import type { CampaignMessage } from "@duckzap/contracts/campaigns";
import { initialsOf } from "@duckzap/ui/components/avatar";
import { Icon } from "@duckzap/ui/components/icon";
import { Fragment } from "react";
import { previewValues } from "../labels";

/** Destaca em negrito o que veio de variável ({nome} → **Carla**). */
const values: Record<string, string> = previewValues;

function Highlighted({ text }: { text: string }) {
  const pieces = text.split(/(\{[a-z_]+\})/g);
  return (
    <>
      {pieces.map((piece, i) => {
        const value = values[piece];
        return value ? <strong key={i}>{value}</strong> : <Fragment key={i}>{piece}</Fragment>;
      })}
    </>
  );
}

/** Prévia no celular, no estilo de conversa do WhatsApp. `text` substitui o corpo (ex.: uma variação). */
export function PhonePreview({
  message,
  text,
  senderName,
  time = "14:20",
}: {
  message: CampaignMessage;
  text?: string;
  senderName: string;
  time?: string;
}) {
  const body = text ?? (message.body.trim() ? `${message.body.trim()}\n\n${message.optOutLine}` : "");
  return (
    <figure className="mx-auto w-full max-w-[300px]">
      <figcaption className="mb-2 text-[13px] text-ink-2">Prévia no celular</figcaption>
      <div className="overflow-hidden rounded-[28px] border-[6px] border-ink bg-surface-2">
        <div className="flex items-center gap-2 bg-rail px-3 py-2.5 text-rail-fg">
          <span className="flex size-7 items-center justify-center rounded-full bg-duck text-[11px] font-extrabold text-on-duck" aria-hidden="true">
            {initialsOf(senderName)}
          </span>
          <span className="truncate text-[13px] font-semibold">{senderName}</span>
        </div>
        <div className="flex min-h-[320px] flex-col justify-end gap-1.5 p-3" aria-live="polite">
          {body ? (
            <div className="max-w-[92%] rounded-xl rounded-tl-sm bg-surface p-2 text-[13px] leading-snug shadow-sm">
              {message.type === "text_image" ? (
                <div className="mb-2 flex h-28 flex-col items-center justify-center gap-1 rounded-lg bg-surface-2 text-ink-2">
                  <Icon name="image" size={22} />
                  <span className="max-w-full truncate px-2 text-xs">{message.imageName ?? "Imagem"}</span>
                </div>
              ) : null}
              <p className="whitespace-pre-line break-words">
                <Highlighted text={body} />
              </p>
              <p className="mt-1 text-right text-[11px] text-ink-2">{time}</p>
            </div>
          ) : (
            <p className="m-auto text-center text-[13px] text-ink-2">Escreva a mensagem para ver a prévia.</p>
          )}
          {body && message.type === "buttons"
            ? message.buttons
                .filter((b) => b.trim())
                .map((button, i) => (
                  <span key={i} className="max-w-[92%] rounded-lg bg-surface py-1.5 text-center text-[13px] font-semibold text-info">
                    {button}
                  </span>
                ))
            : null}
          {body && message.type === "list" ? (
            <span className="flex max-w-[92%] items-center justify-center gap-1.5 rounded-lg bg-surface py-1.5 text-[13px] font-semibold text-info">
              <Icon name="list" size={14} />
              {message.listButtonLabel || "Ver opções"}
            </span>
          ) : null}
        </div>
      </div>
      {body && message.type === "list" && message.listItems.length ? (
        <ul className="mt-2 rounded-control border border-line bg-surface p-2 text-[13px]" aria-label="Opções do menu">
          {message.listItems.map((item, i) => (
            <li key={i} className="border-b border-line py-1.5 last:border-0">
              <span className="font-semibold">{item.title}</span>
              {item.description ? <span className="block text-xs text-ink-2">{item.description}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}
