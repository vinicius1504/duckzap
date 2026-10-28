import { brand } from "@duckzap/brand";
import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/features/onboarding/components/legal-page";

export const metadata: Metadata = { title: "Política de privacidade" };

// Estrutura pensada para a LGPD (Lei 13.709/2018); o texto jurídico está [A DEFINIR].
const sections: LegalSection[] = [
  {
    id: "quem-somos",
    title: "Quem somos e como falar com a gente",
    topics: ["Controlador", "Encarregado (DPO) e canal de contato"],
  },
  {
    id: "papeis",
    title: "Controlador e operador",
    topics: [
      "Dados da conta da empresa (controlador)",
      "Dados dos clientes da empresa nas conversas (operador)",
    ],
  },
  {
    id: "dados-coletados",
    title: "Dados que tratamos",
    topics: [
      "Cadastro e conta",
      "Conversas, mídias e contatos",
      "Dados de uso e dispositivos",
      "Pagamento",
    ],
  },
  {
    id: "finalidades",
    title: "Para que usamos e bases legais (art. 7º)",
    topics: ["Execução de contrato", "Obrigação legal", "Legítimo interesse", "Consentimento"],
  },
  {
    id: "ia",
    title: "Uso de inteligência artificial",
    topics: ["Como os agentes processam as mensagens", "Treinamento de modelos"],
  },
  {
    id: "compartilhamento",
    title: "Com quem compartilhamos",
    topics: [
      "Meta (WhatsApp e Instagram)",
      "Provedor de IA",
      "Gateway de pagamento",
      "Hospedagem e e-mail",
    ],
  },
  { id: "transferencia", title: "Transferência internacional" },
  {
    id: "retencao",
    title: "Por quanto tempo guardamos",
    topics: ["Durante o contrato", "Depois do cancelamento", "Backups"],
  },
  { id: "seguranca", title: "Segurança da informação" },
  {
    id: "direitos",
    title: "Seus direitos como titular (art. 18)",
    topics: [
      "Confirmação e acesso",
      "Correção",
      "Anonimização, bloqueio ou eliminação",
      "Portabilidade",
      "Revogação do consentimento",
      "Como pedir",
    ],
  },
  { id: "consentimento-disparos", title: "Consentimento para mensagens (opt-in)" },
  { id: "cookies", title: "Cookies e tecnologias parecidas" },
  { id: "criancas", title: "Dados de crianças e adolescentes" },
  { id: "incidentes", title: "Incidentes de segurança e comunicação à ANPD" },
  { id: "alteracoes", title: "Alterações desta política" },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Política de privacidade"
      intro={`Como o ${brand.name} trata dados pessoais, de acordo com a Lei Geral de Proteção de Dados (LGPD).`}
      sections={sections}
      other={{ href: "/termos", label: "Termos de uso" }}
    />
  );
}
