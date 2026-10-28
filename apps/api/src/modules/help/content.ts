import type { FaqItem, HelpVideo } from "@duckzap/contracts/help";

/**
 * Conteúdo versionado da Ajuda (FAQ, vídeos e os documentos que o assistente usa como contexto).
 * Editar aqui e subir uma nova versão: não há CMS. Os links `[LINK]` ainda são decisão de produto (vídeos e
 * canais de suporte): a tela não os transforma em link clicável enquanto não forem `https://` ou `/…`.
 */
export const HELP_CONTENT_VERSION = "2026-10-27";

export const faq: FaqItem[] = [
  {
    id: "faq_whatsapp",
    question: "Como conecto meu WhatsApp?",
    answer:
      "Vá em Canais, toque em Novo canal, escolha QR Code e leia o código com o celular em Aparelhos conectados. Se você tem a API oficial da Meta, escolha API oficial e cole as credenciais.",
  },
  {
    id: "faq_ai_mode",
    question: "O agente de IA responde sozinho o tempo todo?",
    answer:
      "Só enquanto a conversa estiver em “IA responde”. Você pode trocar para Copiloto ou Só humano a qualquer momento, na barra acima do chat.",
  },
  {
    id: "faq_ban",
    question: "Como evito que meu número seja bloqueado nas campanhas?",
    answer:
      "Use os valores recomendados de intervalo e lote, envie apenas para quem aceitou receber e dê opção de sair em toda mensagem. Para volume alto, prefira a API oficial.",
  },
  {
    id: "faq_agent_channels",
    question: "Posso usar o mesmo agente em mais de um canal?",
    answer: "Sim. Em Canais, escolha o agente de cada canal ou de cada equipe.",
  },
  {
    id: "faq_import",
    question: "Como importo meus contatos de uma planilha?",
    answer: "Em Clientes, clique em Importar planilha, arraste o arquivo .xlsx ou .csv, confira as colunas e confirme.",
  },
  {
    id: "faq_2fa",
    question: "Por que preciso ativar a verificação em duas etapas?",
    answer:
      "Ela é obrigatória para Proprietário e Administrador, porque essas contas mexem em canais, cobrança e chaves de API. Ative em Ajustes › Minha conta com um app autenticador.",
  },
  {
    id: "faq_api",
    question: "Como integro o Duckzap com meu site ou sistema?",
    answer:
      "Em Ajustes › Integrações, crie uma chave de API (ela aparece uma única vez) e cadastre webhooks para receber eventos. Cada entrega vem assinada no header X-Duckzap-Signature.",
  },
];

export const videos: HelpVideo[] = [
  { id: "vid_whatsapp", title: "Conectar o WhatsApp", durationSeconds: 120, url: null },
  { id: "vid_agent", title: "Criar seu primeiro agente", durationSeconds: 240, url: null },
  { id: "vid_campaign", title: "Enviar uma campanha", durationSeconds: 180, url: null },
];

export const support = {
  hours: "Atendimento de segunda a sexta, 8h às 18h.",
  whatsappUrl: "[LINK]",
  termsUrl: "[LINK]",
  privacyUrl: "[LINK]",
};

/** Documento que o assistente consulta: texto curto + palavras-chave (usadas sem IA e para citar a fonte). */
export type HelpDoc = { id: string; title: string; href: string; keywords: string[]; text: string };

export const helpDocs: HelpDoc[] = [
  {
    id: "doc_agent_handoff",
    title: "Agentes › Comportamento",
    href: "/agentes",
    keywords: ["pessoa", "humano", "transferir", "chamar"],
    text: "Em Agentes de IA, abra o agente e vá na aba Comportamento. Em “Chamar uma pessoa quando”, marque as situações.",
  },
  {
    id: "doc_channels",
    title: "Canais › Novo canal",
    href: "/canais",
    keywords: ["whatsapp", "número", "numero", "qr", "conectar", "canal"],
    text: "Em Canais, toque em Novo canal e escolha QR Code ou API oficial. No QR, abra o WhatsApp no celular › Aparelhos conectados › Conectar um aparelho.",
  },
  {
    id: "doc_team",
    title: "Equipe › Pessoas",
    href: "/equipe",
    keywords: ["convidar", "convite", "usuário", "usuario", "equipe", "atendente"],
    text: "Em Equipe, toque em Convidar pessoa, informe o e-mail e o papel. A pessoa recebe um link para criar a senha.",
  },
  {
    id: "doc_billing",
    title: "Ajustes › Plano e cobrança",
    href: "/ajustes?aba=plano",
    keywords: ["plano", "fatura", "pagamento", "cobrança", "cobranca"],
    text: "Em Ajustes › Plano e cobrança você vê o plano atual, muda de plano e baixa as faturas.",
  },
  {
    id: "doc_account",
    title: "Ajustes › Minha conta",
    href: "/ajustes?aba=conta",
    keywords: ["tema", "escuro", "senha", "2fa", "duas etapas"],
    text: "Em Ajustes › Minha conta você troca a senha, ativa a verificação em duas etapas e escolhe o tema claro, escuro ou automático.",
  },
  {
    id: "doc_import",
    title: "Clientes › Importar planilha",
    href: "/clientes",
    keywords: ["importar", "planilha", "csv", "xlsx", "contatos"],
    text: "Em Clientes, clique em Importar planilha, arraste o arquivo .csv, confira as colunas e confirme que os contatos têm relação com a sua empresa.",
  },
];

export const assistantFallback =
  "Ainda não sei responder isso. Tente com outras palavras ou fale com o suporte aqui ao lado, que a gente te ajuda.";
