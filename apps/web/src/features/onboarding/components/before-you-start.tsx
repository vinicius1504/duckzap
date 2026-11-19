import { Icon, type IconName } from "@duckzap/ui/components/icon";

/**
 * "Antes de começar": o caminho do cadastro em uma lista curta, logo acima do formulário de criar conta.
 * Fica sempre visível (sem etapa extra nem botão "Começar"): quem já quer se cadastrar só rola um pouco;
 * quem quer saber o que vem pela frente lê em poucos segundos. Os nomes seguem os passos do assistente.
 */
const steps: { title: string; detail: string; optional?: boolean }[] = [
  { title: "Criar a conta", detail: "Nome, e-mail e senha." },
  {
    title: "Proteger a conta",
    detail: "Verificação em duas etapas pelo app Google Authenticator ou por código no e-mail.",
    optional: true,
  },
  { title: "Dados da empresa", detail: "Nome e horário de atendimento." },
  { title: "Conectar o WhatsApp", detail: "Leia o QR Code com o celular do negócio. Dá para fazer depois." },
  { title: "Primeiro agente de IA", detail: "Crie o agente e veja como ele responde." },
];

const bring: { icon: IconName; text: string }[] = [
  { icon: "mail", text: "Um e-mail que você usa" },
  { icon: "phone", text: "O celular com o WhatsApp do negócio" },
];

export function BeforeYouStart() {
  return (
    <section aria-labelledby="antes-de-comecar" className="mb-7 rounded-card border border-line bg-surface-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="antes-de-comecar" className="text-[15px] font-bold">
          Antes de começar
        </h2>
        <span className="flex items-center gap-1 text-[13px] text-ink-2">
          <Icon name="clock" size={14} /> Leva uns 5 minutos
        </span>
      </div>

      <ol className="mt-3 flex flex-col gap-2.5">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-2.5">
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-bold"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <p className="min-w-0 text-[13px] leading-snug">
              <strong className="text-sm">{step.title}</strong>
              {step.optional ? <span className="text-ink-2"> (opcional, recomendado)</span> : null}
              <span className="block text-ink-2">{step.detail}</span>
            </p>
          </li>
        ))}
      </ol>

      <h3 className="mt-3.5 text-[13px] font-bold">Tenha em mãos</h3>
      <ul className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
        {bring.map((item) => (
          <li key={item.text} className="flex items-center gap-2">
            <Icon name={item.icon} size={16} className="shrink-0 text-ink-2" />
            {item.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
