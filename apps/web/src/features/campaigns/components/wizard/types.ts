import type {
  Audience,
  CampaignChannel,
  CampaignDraftInput,
  CampaignTemplate,
  CampaignTerms,
} from "@duckzap/contracts/campaigns";

export type Draft = CampaignDraftInput;

/** Dados de referência que o servidor entrega ao assistente. */
export type WizardContext = {
  audiences: Audience[];
  channels: CampaignChannel[];
  metaTemplates: CampaignTemplate[];
  terms: CampaignTerms;
  timeZone: string;
  companyName: string;
  /** Motivo de disparo indisponível (plano expirado, sem permissão). */
  sendBlockedReason: string | null;
};

export type StepProps = {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  ctx: WizardContext;
  errors: string[];
};
