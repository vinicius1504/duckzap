import type { MemberRole } from "@duckzap/contracts/session";
import type { MemberStatus, TeamColor } from "@duckzap/contracts/team";
import type { ChipTone } from "@duckzap/ui/components/chip";

export const memberStatusView: Record<MemberStatus, { label: string; tone: ChipTone }> = {
  active: { label: "Ativo", tone: "ok" },
  invited: { label: "Convite pendente", tone: "warn" },
  inactive: { label: "Inativo", tone: "neutral" },
};

/** Classe do chip de papel (proprietário em destaque, como no canvas). */
export const roleChipClass: Record<MemberRole, string> = {
  owner: "bg-duck text-on-duck",
  admin: "bg-info-bg text-info",
  agent: "",
};

export const teamColorClass: Record<TeamColor, string> = {
  yellow: "bg-duck",
  slate: "bg-ink-2",
  green: "bg-ok",
  blue: "bg-info",
  orange: "bg-duck-beak",
  red: "bg-err",
};

export const teamColors: { value: TeamColor; label: string }[] = [
  { value: "yellow", label: "Amarelo" },
  { value: "slate", label: "Cinza" },
  { value: "green", label: "Verde" },
  { value: "blue", label: "Azul" },
  { value: "orange", label: "Laranja" },
  { value: "red", label: "Vermelho" },
];
