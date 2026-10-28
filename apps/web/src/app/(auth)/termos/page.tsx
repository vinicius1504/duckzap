import { brand } from "@duckzap/brand";
import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/features/onboarding/components/legal-page";

export const metadata: Metadata = { title: "Termos de uso" };

const sections: LegalSection[] = [
  { id: "aceitacao", title: "Aceitação dos termos" },
  {
    id: "servico",
    title: "O que é o serviço",
    topics: ["Atendimento por WhatsApp e Instagram", "Agentes de IA", "Agenda e campanhas"],
  },
  {
    id: "conta",
    title: "Cadastro, conta e acesso",
    topics: ["Quem pode contratar", "Responsabilidade pelas senhas e pelos usuários da equipe"],
  },
  {
    id: "planos",
    title: "Planos, teste grátis, pagamento e cancelamento",
    topics: [
      "Preços e reajustes",
      "Teste grátis",
      "Inadimplência e pausa do envio",
      "Cancelamento e reembolso",
    ],
  },
  {
    id: "uso",
    title: "Uso aceitável",
    topics: [
      "Regras do WhatsApp e da Meta",
      "Proibição de spam e de mensagens sem consentimento",
      "Conteúdo proibido",
    ],
  },
  {
    id: "ia",
    title: "Agentes de IA",
    topics: [
      "Limites das respostas automáticas",
      "Revisão humana",
      "Responsabilidade pelo conteúdo configurado",
    ],
  },
  {
    id: "dados",
    title: "Dados e privacidade",
    topics: [
      "Papel de operador dos dados dos clientes da empresa (LGPD)",
      "Política de privacidade",
    ],
  },
  { id: "disponibilidade", title: "Disponibilidade e suporte" },
  { id: "propriedade", title: "Propriedade intelectual" },
  { id: "responsabilidade", title: "Limitação de responsabilidade" },
  { id: "suspensao", title: "Suspensão e encerramento" },
  { id: "alteracoes", title: "Alterações destes termos" },
  { id: "foro", title: "Lei aplicável e foro" },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Termos de uso"
      intro={`Estas são as regras para usar o ${brand.name}. Ao criar uma conta, a empresa concorda com elas.`}
      sections={sections}
      other={{ href: "/privacidade", label: "Privacidade" }}
    />
  );
}
