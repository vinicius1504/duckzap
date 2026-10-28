# Duckzap — Instruções de desenvolvimento

> Documento-base do projeto. Define **o que** é o Duckzap, **com que** ele é construído e **como** ele deve ser desenvolvido — por pessoas e por agentes de IA.
> Referência visual: canvas "Duckzap — telas do app" (https://claude.ai/code/artifact/89bb6da3-7a6a-43fa-abb1-95b0be5fb475).
> Qualquer decisão que contrarie este arquivo exige um ADR em `docs/adr/` antes do código.

---

## 1. Produto

**Duckzap** é um SaaS multi-tenant de atendimento, vendas e agendamento pelo WhatsApp (e Instagram), com **agentes de IA** que respondem na hora e chamam uma pessoa da equipe quando necessário.

Público: pequenas e médias empresas brasileiras (clínicas, salões, oficinas, imobiliárias, comércio local).

### 1.1 Módulos (espelham as telas do canvas)

| # | Módulo | Escopo |
|---|--------|--------|
| P1 | **Entrar** | Login, "manter conectado", esqueci a senha, estados de erro e de plano expirado (leitura liberada, envio pausado). |
| P4 | **Onboarding** | 1) dados da empresa + horário + boas-vindas · 2) conectar WhatsApp (QR Code ou API oficial) · 3) gerador guiado do primeiro agente com prévia simulada. |
| 1 | **Início** | "Precisa de você" (fila, sem resposta, canal caído, agendamentos a confirmar), KPIs (abertas, novas, 1ª resposta, tempo de atendimento, % IA × pessoas), funil, conversão, tarefas, ranking por atendente. Filtro de período. |
| 2 | **Conversas** | Inbox omnichannel em **Lista** e **Quadro (kanban por etapa)**. Filtros (canal, equipe, etiqueta, prioridade, abas Minhas/Aguardando/Todas/Resolvidas). Ações: assumir, transferir, agendar, resolver. **Modo da conversa: IA responde · Copiloto · Só humano.** Follow-up agendado/pausável, notas internas, respostas rápidas (`/atalho`), "sugerir resposta", reenvio de mensagem falha, áudio, mídia. Painel lateral do cliente. Versão mobile com tab bar. |
| 3 | **Clientes** | CRM: tabela paginada, busca, filtros, ações em massa, importar/exportar planilha, ficha (resumo, histórico, notas, agendamentos). **Listas estáticas** e **segmentos dinâmicos** (filtro salvo). **Etiquetas**, sendo as 4 primeiras as etapas do funil. Consentimento de disparo (opt-in) por cliente. |
| 4 | **Agenda** | Mês/Semana/Lista, responsáveis, tipos de atendimento com duração, detecção de conflito, status (pendente, confirmado, a remarcar, concluído, cancelado), sync bidirecional com Google Calendar, lembretes automáticos (24 h / 2 h) com confirmação por resposta. |
| 5 | **Campanhas** | Assistente em 4 passos (público → mensagem → envio → revisão), tipos (texto, texto+imagem, botões, menu de lista), variáveis `{nome}`, prévia no celular, agendamento, **envio com intervalo seguro (30–60 s) e lotes**, pausar/retomar/cancelar, histórico, rejeitados (opt-out, sem WhatsApp, falha), modelos. Aceite de termos antes do 1º disparo. |
| 6 | **Agentes de IA** | Vários agentes, cada um com um trabalho (atendimento, follow-up, agendamento, Instagram DM, comentários). Abas: Perfil, Conhecimento (texto + documentos PDF/DOCX/TXT), Comportamento (quando responde, quando chamar pessoa, criatividade, limite de mensagens seguidas), Follow-up (sequência), Agenda (tipos que pode marcar), Avançado (prompt completo, versionamento, rollback). **Simulador** isolado. **Copiloto** com feedback útil/ruim. |
| 7 | **Canais** | Números/contas (QR Code, API oficial, Instagram), status de conexão, reconexão, vínculo canal → equipe → agente, mensagens do canal (boas-vindas, fora do horário, encerramento, avaliação), transferência por inatividade, limite do plano. |
| 8 | **Equipe** | Pessoas (papéis: Proprietário, Administrador, Atendente), convites, redefinir senha, ativar/inativar. Equipes com prioridade, horário, saudação, pessoas, canais e agente vinculados. Limite de usuários do plano. |
| 9 | **Configurações** | Empresa, Atendimento (follow-up padrão, encerramento por inatividade), Integrações (Google Calendar, Instagram, WhatsApp API oficial, **chaves de API e webhooks**), Plano e cobrança (planos, faturas), Minha conta (dados, senha, tema claro/escuro/auto, notificações). |
| — | **Ajuda** | FAQ, vídeos, assistente de ajuda (IA sobre a documentação), contato com suporte, refazer tour. |
| — | **Painel Admin** (super admin) | Métricas da plataforma, empresas (em dia, teste, vencidas, atrasadas, expiradas), alterar plano, prorrogar, ativar/desativar, CRUD de planos com preço do 1º mês e recorrente, recursos e link de checkout. |

### 1.2 Planos (limites aplicados no backend, nunca só na UI)

| Plano | Canais | Usuários | Agentes | Extras |
|-------|--------|----------|---------|--------|
| Essencial | 2 | 2 | 1 | — |
| Pro | 5 | 5 | ilimitados | Campanhas |
| Escala | 15 | 20 | ilimitados | Instagram, Copiloto |

Limites e feature flags vivem em tabela (`plans`, `plan_features`), não em código. Preços: `[A DEFINIR]`.

---

## 2. Stack

Princípio: **tecnologia atual, estável e com bom histórico de segurança**. Nada em beta no caminho crítico. Versões fixadas no lockfile e atualizadas por Renovate.

| Camada | Escolha | Por quê |
|--------|---------|---------|
| Linguagem | **TypeScript** (`strict`, `noUncheckedIndexedAccess`) | Um idioma do banco à UI. |
| Runtime | **Node.js LTS** ativo | Suporte de segurança garantido. |
| Monorepo | **pnpm workspaces + Turborepo** | Apps e pacotes compartilhados, cache de build. |
| Web | **Next.js (App Router, última estável) + React 19** | Server Components, Server Actions, streaming. |
| UI | **Tailwind CSS v4 + shadcn/ui (Radix)** | Acessível por padrão; tokens do design (§2.1). |
| Estado cliente | **TanStack Query** + URL state (`nuqs`) | Cache de servidor; filtros na URL. |
| Formulários / validação | **React Hook Form + Zod** | O **mesmo schema Zod** valida cliente, Server Action, API e jobs. |
| API | Server Actions (UI interna) + **REST `/api/v1`** versionada (pública, com OpenAPI gerado do Zod) | Integrações de clientes via chave de API. |
| Banco | **PostgreSQL 17+** com **Row-Level Security** | Isolamento de tenant no próprio banco. |
| ORM | **Drizzle ORM** + `drizzle-kit` (migrations versionadas) | SQL explícito, bom suporte a RLS e `SET LOCAL`. |
| Busca / vetores | `pg_trgm` (busca) + **pgvector** (conhecimento dos agentes) | Sem serviço extra no início. |
| Cache / filas | **Valkey/Redis** + **BullMQ** | Mensagens, campanhas, follow-ups, lembretes, ingestão de docs. |
| Tempo real | **WebSocket em servidor dedicado (Socket.IO ou `ws`) com Redis adapter**, rodando na VPS | Inbox ao vivo, status de canal, digitando. |
| Auth | **Better Auth** (organizações, convites, 2FA TOTP, passkeys, sessões em banco) | Multi-tenant nativo; sessões revogáveis. |
| WhatsApp | **Multi-provedor** atrás de uma interface única: **Meta Cloud API** (oficial), **Evolution API** (open source, QR), e depois uazapi, WAHA, Z-API etc. | Ver §3.6. O sistema nunca depende de um provedor só. |
| Instagram | Instagram Graph API (DM + comentários) via app Meta | |
| IA | **Anthropic Claude** via SDK oficial, atrás de uma interface `LLMProvider` | Ver §4. Padrão: `claude-sonnet-5-5` (agentes), `claude-haiku-5-5` (classificação, roteamento, resumos). |
| Arquivos | S3-compatível (**Cloudflare R2** ou S3) com URLs assinadas curtas | Mídia de conversa, documentos, logos. |
| Pagamentos | **Asaas** ou **Stripe** (Pix, boleto, cartão, assinatura) via webhook assinado | `[DECIDIR em ADR]`. |
| E-mail | Resend (ou SES) + React Email | Convites, recuperação de senha, faturas. |
| Calendário | Google Calendar API (OAuth, escopo mínimo) | |
| Observabilidade | **OpenTelemetry** + **Sentry** + logs JSON estruturados (pino) | Traços cruzam web → fila → worker → LLM. |
| Testes | **Vitest** (unit/integração), **Playwright** (E2E), **Testcontainers** (Postgres/Redis reais) | |
| Qualidade | ESLint (flat config) + Prettier, `tsc --noEmit`, Knip | |
| Infra | **VPS Hostinger (KVM, datacenter Brasil)** com Docker + **Dokploy/Coolify** + Caddy; Cloudflare na frente. Tudo em containers, portável para qualquer provedor. Ver §7. | Custo previsível, controle total, sem lock-in. |
| CI/CD | **GitHub Actions** + Renovate + CodeQL + Gitleaks + `pnpm audit` + Trivy (imagens) | |

### 2.1 Tokens de design (do canvas)

```css
--ink:#0F1F2B; --ink2:#566672; --line:#E3E8EB; --bg:#F6F7F4;
--duck:#FFC42E; --duck2:#E9AA05; --duck-beak:#FF8A2E;
--ok:#17794F; --okbg:#E2F3EA; --warn:#7A4F00; --warnbg:#FFF0C7;
--err:#B3261E; --errbg:#FCE7E5; --info:#1D5F8A; --infobg:#E2EFF8;
```

- Fonte: **Plus Jakarta Sans** (400–800).
- Raio: botões/inputs 10 px, cards 14 px, chips 99 px.
- Navegação: rail escuro de 88 px no desktop; tab bar inferior no mobile (Início, Conversas, Clientes, Agenda, Mais).
- Alvo de toque ≥ 44 px, contraste ≥ 4.5:1, foco visível (`outline 3px`), HTML semântico. Tema claro/escuro/automático.
- Textos da UI em pt-BR, tom simples e direto ("Reconectar agora", não "Reestabelecer sessão").

---

## 3. Arquitetura

### 3.1 Estrutura do monorepo

```
duckzap/
├─ apps/
│  ├─ web/            # Next.js — app, landing, API /api/v1, webhooks
│  ├─ worker/         # BullMQ workers (mensagens, IA, campanhas, follow-up, lembretes, ingestão)
│  └─ realtime/       # servidor WebSocket
├─ packages/
│  ├─ db/             # schema Drizzle, migrations, policies RLS, seed
│  ├─ core/           # domínio: casos de uso puros (sem framework)
│  ├─ contracts/      # schemas Zod compartilhados + tipos de eventos
│  ├─ ai/             # LLMProvider, orquestrador de agentes, tools, guardrails, evals
│  ├─ channels/       # interface MessagingProvider + adaptadores: meta-cloud, evolution, uazapi, instagram…
│  ├─ auth/           # Better Auth config, RBAC, checagem de plano
│  ├─ ui/             # componentes shadcn + tokens
│  └─ config/         # eslint, tsconfig, env (validado com Zod)
├─ docs/
│  ├─ adr/            # decisões de arquitetura
│  └─ runbooks/       # incidentes, rotação de segredos, restore
└─ INSTRUCTIONS.md
```

### 3.2 Camadas e regras de dependência

`app (UI/rotas) → core (casos de uso) → db / channels / ai (adaptadores)`

- `core` não importa Next.js, Drizzle nem SDKs — recebe portas (interfaces).
- Rotas e Server Actions são finas: **autenticar → autorizar → validar (Zod) → chamar caso de uso → serializar**.
- Toda escrita relevante emite um **evento de domínio** (`conversation.assigned`, `appointment.created`…) gravado numa tabela *outbox* na mesma transação; um worker publica para filas/realtime. Nada de "salvar e torcer para a fila funcionar".

### 3.3 Fluxo de uma mensagem recebida

```
Meta/Gateway ──webhook──▶ /api/webhooks/{canal}
   1. verifica assinatura (HMAC) e origem → 401 se falhar
   2. grava evento bruto (idempotência por message_id) → responde 200 rápido
   3. enfileira `inbound.process`
worker:
   4. resolve tenant + canal + cliente (upsert) + conversa
   5. aplica regras: horário, equipe, modo da conversa
   6. modo "IA responde" → `ai.respond` | "Copiloto" → `ai.suggest` | "Só humano" → fila da equipe
   7. publica no realtime → inbox atualiza
```

### 3.4 Multi-tenancy (inegociável)

- Toda tabela de negócio tem `organization_id NOT NULL` + índice.
- **RLS ativo em todas elas**, com policy `organization_id = current_setting('app.org_id')::uuid`.
- Cada request/job abre transação e executa `SET LOCAL app.org_id = …` a partir da sessão autenticada — **nunca** de parâmetro vindo do cliente.
- O app conecta com um papel de banco **sem `BYPASSRLS`**. Só migrations e o Painel Admin (papel separado, auditado) ignoram RLS.
- Teste automatizado obrigatório: para cada tabela, um usuário do tenant A não lê nem escreve dados do tenant B.

### 3.5 Modelo de dados (núcleo)

`organizations`, `members` (papel), `teams`, `team_members`, `business_hours`, `channels`, `contacts`, `contact_tags`, `tags` (com `funnel_stage`), `lists`, `segments` (filtro JSON), `conversations` (status, modo, etapa, responsável, equipe), `messages` (direção, tipo, status de entrega, `external_id` único), `internal_notes`, `quick_replies`, `tasks`, `appointments`, `appointment_types`, `reminders`, `campaigns`, `campaign_recipients` (status, motivo), `templates`, `agents`, `agent_versions`, `agent_knowledge` (+ `knowledge_chunks` com `vector`), `followup_sequences`, `copilot_feedback`, `consents` (status `pending | granted | denied | expired`, origem do contato, data, texto do convite e resposta como prova), `api_keys` (hash), `webhooks_out`, `plans`, `plan_features`, `subscriptions`, `invoices`, `audit_logs`, `outbox_events`.

IDs: UUID v7. Datas: `timestamptz` em UTC; fuso da organização só na exibição. Dinheiro: inteiro em centavos.

### 3.6 Provedores de WhatsApp (multi-provedor)

Cada **canal** escolhe seu provedor. O resto do sistema (conversas, agentes, campanhas) só conhece eventos e comandos **canônicos** — nunca o formato de um provedor.

| Provedor | Tipo | Quando usar | Observações |
|----------|------|-------------|-------------|
| **Meta Cloud API** | Oficial | Volume alto, campanhas, clientes que exigem estabilidade | Janela de 24 h, templates aprovados, cobrança por conversa da Meta. Webhook assinado (HMAC). |
| **Evolution API** | Open source, QR (Baileys) — auto-hospedado | Padrão do QR no início: grátis, multi-instância, REST + webhooks | Roda como container próprio. Não oficial: risco de banimento; botões/listas instáveis. |
| **uazapi** | SaaS pago, QR | Fase futura: tirar a operação do QR da nossa VPS | Só adaptador novo; nada muda no domínio. |
| WAHA, Z-API, W-API… | QR (self-hosted ou SaaS) | Se um cliente ou o mercado pedir | Mesmo padrão. |
| ~~open-wa (wa-automate)~~ | QR via navegador (Puppeteer) | **Não recomendado** | Um Chrome por sessão: pesado demais para a VPS e menos estável que Baileys. |

**Interface (`packages/channels`):**

```ts
interface MessagingProvider {
  readonly kind: "meta_cloud" | "evolution" | "uazapi" | /* … */ string;
  capabilities(): ProviderCapabilities;           // botões, listas, templates, mídia, reações, janela 24h…
  connect(channel): Promise<ConnectResult>;      // QR, pairing code ou credenciais
  disconnect(channel): Promise<void>;
  status(channel): Promise<ConnectionStatus>;    // normalizado: connected | qr_pending | disconnected | banned
  send(channel, msg: OutboundMessage): Promise<SendResult>;   // OutboundMessage é canônico
  parseWebhook(req): Promise<InboundEvent[]>;    // provedor → eventos canônicos (validados com Zod)
  verifyWebhook(req): Promise<boolean>;
}
```

**Regras:**
- Um adaptador por provedor; adicionar provedor = novo arquivo + testes de contrato, sem tocar no domínio.
- **Testes de contrato**: a mesma suíte roda contra todos os adaptadores (com payloads gravados de cada provedor).
- **Capacidades com degradação**: se o provedor não suporta botões, a campanha/agente cai para texto numerado; a UI só mostra opções suportadas pelo canal.
- Envio sempre pela fila, com rate limit **por canal e por provedor**; idempotência por `external_id`.
- **Webhooks de provedores não oficiais** (que não assinam): URL com token secreto aleatório por canal (`/api/webhooks/wa/{provider}/{channelToken}`), checagem do header de API key do provedor e, quando possível, allowlist de IP. Token rotacionável.
- Credenciais de cada canal (token Meta, apikey da Evolution, token uazapi) cifradas (§5.2).
- O status normalizado alimenta os avisos de "canal desconectado" no Início, em Canais e no topo do app.
- **Troca de provedor** de um canal (ex.: Evolution → oficial) preserva conversas e contatos: o vínculo é pelo número, não pelo provedor.
- Verificar e registrar em ADR a licença de cada provedor open source antes de usar em produção.

---

## 4. Agentes de IA do produto (runtime)

### 4.1 Orquestração

Padrão **roteador + especialistas**, determinístico onde dá e com LLM só onde agrega:

```
mensagem ─▶ Regras determinísticas (horário, modo, opt-out "SAIR", palavra de urgência)
         ─▶ Roteador (haiku): classifica intenção → {dúvida, agendar, comprar, reclamação, humano, spam}
         ─▶ Especialista do canal/equipe:
              • Atendimento  • Agendamento  • Follow-up  • Instagram DM  • Comentários
         ─▶ Guardrails de saída ─▶ envio  |  handoff para humano
Copiloto: mesmo pipeline, mas o resultado vira sugestão no compositor, nunca é enviado sozinho.
```

- Cada especialista é **configuração** (`agent_versions`: prompt, tom, conhecimento, regras, tools permitidas), não código novo.
- O orquestrador é uma **máquina de estados explícita** por conversa (`ai_active → waiting_customer → handoff_requested → human_active → resolved`). Transições são eventos auditados.
- Um job por conversa por vez (lock no Redis com chave `conv:{id}`) — sem respostas duplicadas ou fora de ordem. Mensagens que chegam em rajada são agregadas por ~3–5 s antes de responder.

### 4.2 Tools (function calling)

Tools pequenas, tipadas com Zod, **escopadas ao tenant e à conversa** pelo servidor — o modelo nunca escolhe `organization_id` nem `contact_id` arbitrário.

| Tool | Efeito | Confirmação |
|------|--------|-------------|
| `search_knowledge(query)` | busca vetorial no conhecimento do agente | — |
| `list_available_slots(type, range)` | lê agenda | — |
| `book_appointment(slot, type)` | cria agendamento **pendente** | somente tipos liberados ao agente |
| `reschedule / cancel_appointment` | altera o agendamento do próprio cliente | — |
| `update_contact_fields(campos permitidos)` | nome, e-mail | allowlist de campos |
| `add_tag(tag permitida)` | move etapa do funil | allowlist |
| `request_human(reason)` | handoff para a equipe | sempre disponível |
| `schedule_followup(step)` | agenda retomada | respeita horário comercial |

Proibido ao agente: enviar para outro número, ler outra conversa, alterar preços, campanhas, configurações, apagar dados.

### 4.3 Guardrails

- **Prompt injection**: conteúdo do cliente e de documentos entra sempre como dado delimitado, nunca concatenado às instruções. Instruções do sistema dizem explicitamente que texto do cliente não altera regras.
- **Saída**: validação antes de enviar — sem preço que não esteja no conhecimento ("Nunca invente preços"), sem dados de terceiros, limite de tamanho, limite de mensagens seguidas, bloqueio de URLs fora de allowlist da empresa.
- **Handoff obrigatório**: pedido de pessoa, reclamação/urgência, pergunta fora do conhecimento, baixa confiança do roteador, 2 falhas de tool seguidas.
- **PII**: não mandar ao LLM mais do que o necessário (janela de conversa limitada + resumo); nada de CPF/cartão no prompt; logs de prompts com mascaramento.
- **Custos**: orçamento de tokens por organização e por plano, rate limit por conversa, prompt caching do bloco fixo (sistema + conhecimento), fallback de modelo em erro/timeout.
- **Versionamento**: toda alteração de agente cria `agent_versions` nova; "voltar à versão anterior" é rollback de ponteiro.
- **Simulador**: usa as mesmas tools em modo *dry-run* contra dados fictícios — nunca envia nem grava.

### 4.4 Qualidade (evals)

- `packages/ai/evals/`: conjunto de conversas-teste por tipo de agente (agendar, preço desconhecido, injeção, pedido de humano, cliente irritado, opt-out).
- Rodar no CI quando mudar prompt-base, roteador ou tools. Regressão bloqueia merge.
- Feedback do Copiloto (útil/ruim) alimenta novos casos.

---

## 5. Segurança (baseline obrigatório)

Referências: **OWASP ASVS 5 nível 2**, OWASP Top 10, OWASP Top 10 para LLM, **LGPD**.

### 5.1 Identidade e acesso
- Senhas com Argon2id (padrão do Better Auth), checagem contra vazadas (HIBP k-anonymity), 2FA TOTP e passkeys; 2FA **obrigatório** para Proprietário, Administrador e super admin.
- Sessões em banco, cookie `HttpOnly; Secure; SameSite=Lax`, rotação no login, revogação em troca de senha/papel.
- **RBAC no servidor** em todo caso de uso (`can(member, "campaign.send")`). UI esconder botão não é autorização.
- Rate limit em login, recuperação de senha, convites, webhooks e API pública (Redis sliding window).
- Painel Admin em subdomínio/rota separada, papel próprio, 2FA, IP allowlist opcional, toda ação em `audit_logs`.

### 5.2 Dados
- TLS em tudo; HSTS.
- **Segredos de integração** (tokens Meta, Google OAuth, chaves de webhook) cifrados em repouso com *envelope encryption* (chave de dados por tenant, chave mestra no KMS). Nunca em log, nunca devolvidos à UI (mostrar só últimos 4).
- Chaves de API: prefixo visível (`dz_live_…`), armazenadas como **hash**; escopos; revogáveis; último uso registrado.
- Uploads: validação de tipo real (magic bytes), tamanho máximo, varredura antivírus para documentos, armazenados fora do domínio do app, entregues por URL assinada.
- Backups diários com PITR, teste de restore mensal (runbook).

### 5.3 Aplicação
- Validação Zod em **toda** entrada (forms, API, webhooks, jobs, saída de LLM).
- Queries só via Drizzle/SQL parametrizado.
- CSP estrita com nonce, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors 'none'`.
- Server Actions: checar origem (CSRF) — padrão do Next — e nunca confiar em IDs ocultos de formulário sem checar posse.
- Webhooks de entrada: verificar assinatura (`X-Hub-Signature-256` da Meta, assinatura do gateway de pagamento), janela de tempo, idempotência.
- Webhooks de saída (para clientes): assinados com HMAC, retentativa com backoff, proteção **SSRF** (bloquear IPs privados/metadata).
- Variáveis de ambiente validadas com Zod no boot; app não sobe com configuração inválida.

### 5.4 WhatsApp e campanhas (risco de banimento e legal)
- **API oficial é o caminho recomendado**; QR Code (não oficial, Evolution/uazapi…) é oferecido com aviso claro de risco. A Evolution roda em container isolado, em rede própria, sem credenciais do banco principal e sem porta pública.
- Campanhas só para contatos com **opt-in registrado** (`consents`); opt-out ("SAIR", "PARAR") processado antes de qualquer outra lógica e respeitado para sempre.
- Em provedor não oficial (QR), o envio segue obrigatoriamente o **motor de envio seguro** (§5.7).
- Na API oficial, respeitar janela de 24 h e templates aprovados (sem variação por IA: o template é o aprovado pela Meta).

### 5.5 LGPD
- Base legal por finalidade; registro de consentimento com data, origem e texto aceito.
- Exportação e exclusão de dados do titular (contato) por solicitação da empresa.
- Retenção configurável de mensagens e mídia; exclusão em cascata ao encerrar a conta (após prazo de carência).
- Encarregado (DPO) e política de privacidade publicados; DPA com subprocessadores (Meta, Anthropic, provedor de nuvem, pagamentos).
- Dados de saúde (clínicas) são **dados sensíveis**: minimizar no prompt, nunca usar para treino, acesso auditado.

### 5.6 Supply chain
- Lockfile commitado, `pnpm install --frozen-lockfile` no CI, Renovate com agrupamento e espera mínima de alguns dias para versões novas.
- CodeQL, Gitleaks (pré-commit e CI), `pnpm audit`, Trivy nas imagens, imagens base mínimas (distroless/alpine) e não-root.
- Branch `main` protegida: PR + CI verde + revisão obrigatória.

### 5.7 Motor de envio seguro — campanhas em provedor não oficial (QR)

Escopo: canais Evolution/uazapi/WAHA. Uso inicial **demonstrativo e de teste**. Objetivo: envio com ritmo humano, mensagens variadas e volume baixo, para reduzir o risco de bloqueio do número. A UI deixa claro ao cliente que **o risco não é zero**. Todas as regras rodam no **worker** (servidor), nunca no navegador, e não podem ser desligadas pela UI.

**1. Público**
- Campanha só para contatos com opt-in registrado (`consent = granted`). Contato sem opt-in só pode receber o **convite de consentimento** (item 7).
- Opt-out (`SAIR`, `PARAR`, `CANCELAR`…) bloqueia na hora e para sempre.
- Remover números sem WhatsApp (checagem prévia no provedor) e duplicados.
- Ordem de envio **embaralhada**; priorizar quem conversou com a empresa nos últimos 90 dias.

**2. Limites (hard, por canal)**
- **Máximo 50 mensagens de campanha por dia por número.** Respostas de atendimento não contam.
- Máximo ~15 por hora.
- **Número novo (aquecimento)**: dias 1–3 até 10/dia, dias 4–7 até 25/dia, depois 50.
- Janela de envio: horário comercial da organização (padrão 08h–20h), sem domingos/feriados por padrão.
- Público maior que o limite: a campanha é **dividida automaticamente em dias**; a UI mostra "64 pessoas → 2 dias (50 + 14)" e **recomenda** campanhas menores e separadas por segmento.

**3. Intervalos aleatórios**
- Após cada mensagem, sortear o próximo intervalo entre **mín. e máx. configuráveis** (padrão 45–120 s; piso 30 s), com distribuição irregular (não uniforme). Nunca dois intervalos iguais seguidos.
- A cada 8–15 mensagens (sorteado), **pausa longa** de 5–15 min.
- Antes de enviar, presença "digitando" proporcional ao tamanho do texto (quando o provedor suporta).
- O agendamento do próximo envio é um job atrasado no BullMQ (persistente: sobrevive a restart).

**4. Variação da mensagem por IA**
- O usuário escreve a **mensagem base**. A IA (`claude-haiku-5-5`) gera variações mantendo o **mesmo sentido**.
- Regras de geração: preservar variáveis (`{nome}`, `{empresa}`…), links, preços, datas e a linha de saída **exatamente iguais**; não inventar informação; tamanho de ±20% da base; mesmo tom.
- **Validador automático** (código, não IA) rejeita a variação se faltar variável, link ou opt-out, se aparecer número/preço/URL que não existe na base, ou se ficar parecida demais com outra (similaridade alta) ou distante demais da base.
- **Modo padrão: banco de variações aprovado**. Gerar 15–30 variações, o usuário revisa e aprova na tela antes do disparo; o envio sorteia sem repetir a mesma variação em mensagens seguidas. Custo baixo e tudo auditável.
- **Modo opcional: variação por mensagem**. Cada envio gera uma variação nova, passando pelo mesmo validador; se falhar duas vezes, usa uma variação do banco aprovado. Fica registrada em `campaign_recipients` o texto exato enviado.
- Variáveis por contato (`{nome}`) também diferenciam cada mensagem; mídia (se houver) é a mesma.
- Toda mensagem termina com opção de saída ("Responda SAIR para não receber mais").

**5. Parada automática (circuit breaker)**
- Pausar a campanha se: canal desconectar; falhas > 10% nas últimas 20; 3+ opt-outs ou denúncias nas últimas 20; erro do provedor indicando restrição.
- Contato que responde sai da campanha e vira conversa normal (agente ou equipe).
- Retomar só manualmente, com aviso do motivo.

**6. Registro**
- Para cada envio: variação usada, intervalo sorteado, horário, status de entrega, resposta/opt-out. Alimenta Histórico e Rejeitados.

**7. Convite de consentimento (primeiro contato)**

Mensagem única que pergunta a um contato novo se ele aceita receber mensagens da empresa. É a porta de entrada para campanhas.

- **Quem pode receber**: contato com **origem legítima registrada**: já é cliente, deixou o número em atendimento, formulário, balcão, evento, indicação. Na importação de planilha, o campo `origem` é obrigatório e o usuário confirma: "Estes contatos têm relação com a minha empresa e não foram comprados". Sem origem, não envia.
- **Uma vez só por contato, para sempre.** Sem reenvio, sem follow-up. Não respondeu = continua sem opt-in (`consent = pending → expired` após 7 dias).
- **Conteúdo**: identificação da empresa + motivo + pergunta. Sem oferta, preço, link ou mídia. Ex.: "Oi, {nome}! Aqui é a {empresa}. Podemos te enviar novidades e lembretes por aqui? Responda SIM para aceitar ou NÃO para não receber."
- **Respostas**: `SIM`/aceito/pode → `consent = granted` (grava data, hora, texto enviado e resposta como prova). `NÃO`/sair/qualquer recusa → `consent = denied`, bloqueio permanente. Outra resposta → vira conversa normal e o agente pode perguntar de novo **uma vez** dentro dessa conversa.
- **Interpretação da resposta**: palavras-chave primeiro; IA (haiku) só para casos ambíguos, e na dúvida conta como **não aceito**.
- **Limites próprios, mais baixos**: até **20 convites/dia por número**, dentro do teto de 50 mensagens/dia do canal, com os mesmos intervalos aleatórios, pausas, janela de horário e variação por IA (itens 2–4).
- **Circuit breaker mais sensível**: pausa se 3 recusas/denúncias ou 2 falhas nas últimas 15.
- **Disparo**: manual ("Convidar contatos sem opt-in" em Clientes) ou automático para novos contatos importados/cadastrados, configurável e **desligado por padrão**.
- Contato que mandou mensagem primeiro **não recebe convite**: o agente pergunta na própria conversa, de forma natural, no fim do atendimento.

**Fora de escopo (não implementar):** rotação de números para escapar de bloqueio, múltiplos chips por campanha, envio a listas compradas ou sem opt-in, ocultar o remetente.

---

## 6. Como desenvolver — orquestração de agentes de desenvolvimento

O projeto é construído com agentes de IA (Claude Code e similares) trabalhando sob regras claras. **Prático**: o menor número de agentes que resolve a tarefa. **Seguro**: nenhum agente sozinho decide e aprova.

### 6.1 Papéis

| Papel | Faz | Não faz |
|-------|-----|---------|
| **Orquestrador** (sessão principal) | Lê a tarefa, consulta este arquivo e os ADRs, quebra em passos, delega, integra, abre o PR. | Pular gates; delegar o que é uma busca de 2 arquivos. |
| **Planejador** | Para tarefas médias/grandes: plano com arquivos afetados, migrations, riscos, testes. | Escrever código. |
| **Implementador** | Escreve código + testes de uma fatia vertical (schema → caso de uso → rota → UI). | Alterar módulos fora do escopo do plano. |
| **Revisor de código** | Revisão independente do diff (correção, legibilidade, aderência às camadas). Recebe o código, não a conclusão do implementador. | Corrigir e aprovar o próprio fix. |
| **Revisor de segurança** | Obrigatório quando o diff toca: auth, RBAC, RLS/migrations, webhooks, uploads, segredos, tools de IA, campanhas, Painel Admin. Checklist §5. | — |
| **Testador** | Roda unit/integração/E2E/evals, reporta falhas com saída real. | Marcar como passou o que não rodou. |

Tarefas pequenas (um bug, um ajuste de UI): orquestrador implementa direto + revisão. Não criar subagentes à toa.

### 6.2 Fluxo de uma tarefa

```
1. Entender   → ler INSTRUCTIONS.md, ADRs, código vizinho; perguntar só o que for decisão de produto
2. Planejar   → plano curto no PR/issue (obrigatório se tocar >3 arquivos ou schema)
3. Implementar→ fatia vertical, com testes, em branch `feat/…` / `fix/…`
4. Verificar  → typecheck + lint + testes + (evals se mexeu em IA) — tudo local antes do PR
5. Revisar    → revisor de código; + revisor de segurança se aplicável
6. Corrigir   → implementador ajusta; revisor confere de novo
7. Entregar   → PR com descrição: o quê, por quê, como testar, riscos, screenshots
```

Paralelizar só trabalho independente (ex.: módulo Agenda e módulo Campanhas em branches/worktrees separados). Dois agentes nunca editam o mesmo arquivo ao mesmo tempo.

### 6.3 Gates (nenhum agente ignora)

- Nunca commitar segredos, `.env`, dumps ou dados reais de clientes.
- Nunca desativar RLS, verificação de assinatura, rate limit ou validação "para testar".
- Nunca `--no-verify`, `force push` em `main`, ou merge sem CI verde.
- Migration destrutiva (drop/rename de coluna com dados) exige plano de expand/contract e aprovação humana.
- Mudança em prompt-base, tools de IA ou limites de campanha exige evals verdes e aprovação humana.
- Ações irreversíveis ou externas (deploy de produção, envio real de mensagens, cobrança) só com confirmação humana explícita.
- Relatar resultados com fidelidade: teste falhou → mostrar a saída; passo pulado → dizer que pulou.

### 6.4 Padrões de código

- Nomes de domínio em inglês no código (`conversation`, `appointment`), textos de UI em pt-BR via arquivo de mensagens (preparado para i18n).
- Funções pequenas, sem `any`, sem `as` para silenciar tipo; erros de domínio tipados (`Result` ou classes de erro), nunca `throw "string"`.
- Comentário só para o *porquê* não óbvio.
- Toda feature nova: teste do caso de uso + teste de autorização (outro tenant / papel sem permissão) + E2E do caminho feliz se for fluxo de usuário.
- Commits no padrão Conventional Commits.

### 6.5 Definição de pronto

- [ ] Funciona no desktop e no mobile (≥ 360 px), tema claro e escuro
- [ ] Estados de vazio, carregando, erro e limite de plano tratados
- [ ] Acessível (teclado, foco, rótulos, contraste)
- [ ] Autorização no servidor + teste de isolamento de tenant
- [ ] Validação Zod nas entradas
- [ ] Logs e traços sem dados sensíveis
- [ ] Testes e evals relevantes passando no CI
- [ ] Revisões concluídas (código e, se aplicável, segurança)
- [ ] Docs/ADR atualizados quando a decisão mudou

---

## 7. Deploy e infraestrutura (VPS Hostinger)

### 7.1 Dimensionamento

| Fase | Plano | Uso |
|------|-------|-----|
| **Atual: desenvolvimento / beta fechado** | **KVM 1** (1 vCPU, 4 GB) | Ver §7.1.1. Até ~10 canais QR e poucas empresas. |
| Primeiros clientes pagantes | **KVM 2** (2 vCPU, 8 GB) | Tudo na mesma VPS. |
| Lançamento (até ~100 empresas) | **KVM 4** (4 vCPU, 16 GB) | Tudo na mesma VPS, com folga para workers e campanhas. |
| Crescimento | 2 VPS: **app** (web, realtime, workers) + **dados** (Postgres, Valkey) | Separar antes de escalar vertical demais. |

Datacenter no Brasil (latência e LGPD). A LLM roda na API da Anthropic, não na VPS.

#### 7.1.1 Rodando na KVM 1 (4 GB)

- **Sem painel de deploy** (Dokploy/Coolify consomem ~0,5–1 GB): `docker compose` + Caddy, deploy por GitHub Actions via SSH (`docker compose pull && up -d`). Painel entra na KVM 2.
- **Build nunca na VPS**: imagens são construídas no GitHub Actions e só baixadas.
- **Swap de 4 GB** e limites de memória em cada container.
- **Evolution API compartilha Postgres e Valkey** com o app (banco e prefixo próprios), em vez de subir os seus.
- Opcional para aliviar: Postgres gerenciado (Neon/Supabase, região São Paulo) no plano gratuito/básico.
- Orçamento aproximado de RAM: Postgres 600 MB · Valkey 200 MB · web 400 MB · worker 300 MB · realtime 150 MB · Evolution 400 MB + ~50 MB por instância · Caddy 50 MB · SO 400 MB.
- Gatilhos para subir de plano: memória > 80% sustentada, swap em uso constante, fila de mensagens atrasando, ou primeiro cliente pagante.

### 7.2 Serviços (docker compose)

```
cloudflare (DNS, proxy, WAF, DDoS)
   └─▶ caddy          :80/:443 — único serviço exposto, HTTPS automático
         ├─▶ web       Next.js `output: "standalone"`
         └─▶ realtime  WebSocket
       worker          BullMQ (sem porta)
       evolution-api   provedor QR (rede própria, sem porta pública; fala com o app só por webhook interno)
       postgres        volume persistente, só rede interna
       valkey          AOF ligado, senha, só rede interna
```

- Build com `turbo prune <app> --docker` → uma imagem enxuta por app, publicada no GHCR pelo GitHub Actions.
- Deploy pelo **Dokploy** (ou Coolify): puxa a imagem nova, sobe, faz health check e troca sem downtime.
- `docker-compose.local.yml` usa as mesmas imagens para desenvolvimento.

### 7.3 Endurecimento da VPS (fazer antes do primeiro deploy)

- Usuário não-root com sudo; SSH só por chave; `PermitRootLogin no`; porta SSH restrita por IP quando possível.
- Firewall (UFW + firewall do painel Hostinger): entrada só 22, 80, 443. Postgres/Valkey **nunca** expostos.
- Liberar 80/443 só para IPs da Cloudflare; Caddy com certificado de origem.
- `unattended-upgrades` para patches de segurança; fail2ban no SSH.
- Containers como usuário não-root, `read_only` quando possível, limites de CPU/memória, `restart: unless-stopped`.
- Segredos nas variáveis do Dokploy, nunca no repositório nem na imagem.
- Logs com rotação (o disco não pode encher).

### 7.4 Backup e recuperação

- Snapshot da Hostinger **não é** backup suficiente.
- Postgres: `pg_dump` diário + WAL contínuo (WAL-G ou pgBackRest) enviados **cifrados** para o Cloudflare R2, retenção de 30 dias.
- Volumes de configuração (Caddy, Dokploy) também no backup.
- Teste de restore mensal em VPS temporária, seguindo `docs/runbooks/restore.md`.
- Monitoramento externo (Uptime Kuma em outro lugar, ou Better Stack) + alertas de disco, CPU, memória e fila parada.

### 7.5 Portabilidade (regra)

Nada pode depender da Hostinger nem de provedor específico: sem cron do sistema (usar jobs repetíveis do BullMQ), sem arquivos em disco local (usar R2), configuração só por variáveis de ambiente validadas, cache do Next compartilhado no Valkey se houver mais de uma instância de `web`. Trocar de VPS ou migrar o Postgres para um serviço gerenciado deve ser só mudar variáveis e o destino do deploy.

---

## 8. Roadmap de construção

| Fase | Entrega |
|------|---------|
| **0 — Fundação** | VPS Hostinger endurecida + Dokploy + backups testados, monorepo, CI/CD com gates de segurança, Postgres + RLS + teste de isolamento, Better Auth com organizações/2FA, RBAC, planos e limites, design system com tokens, shell do app (rail + tab bar), observabilidade. |
| **1 — Núcleo de atendimento** | Interface `MessagingProvider` + adaptadores Evolution e Meta Cloud API com testes de contrato, webhooks idempotentes, Conversas (lista, chat, notas, respostas rápidas, assumir/transferir/resolver), Clientes básico, Equipe e horários, realtime. |
| **2 — Agentes de IA** | Orquestrador, Agente de atendimento, conhecimento com pgvector, handoff, modos IA/Copiloto/Humano, simulador, gerador guiado, evals no CI. Onboarding completo. |
| **3 — Agenda** | Tipos de atendimento, calendário, conflitos, Google Calendar, lembretes, tool de agendamento do agente. |
| **4 — CRM e funil** | Etiquetas/etapas, Quadro kanban, listas e segmentos, importação/exportação, tarefas, Início com KPIs. |
| **5 — Campanhas** | Consentimento, assistente, envio seguro, rejeitados, modelos, histórico. |
| **6 — Monetização e admin** | Cobrança recorrente, faturas, upgrade/downgrade, Painel Admin, plano expirado (somente leitura). |
| **7 — Expansão** | Instagram DM e comentários, Copiloto com feedback, API pública + webhooks de saída, Ajuda com assistente. |

Cada fase termina com deploy em staging, E2E dos fluxos da fase e revisão de segurança.

---

## 9. Decisões em aberto (registrar em ADR)

- Gateway de pagamento: Asaas × Stripe × Mercado Pago.
- Postgres na própria VPS (início) × gerenciado em São Paulo (quando a operação de backup pesar).
- Dokploy × Coolify como painel de deploy.
- Oferecer ou não o QR Code não oficial no lançamento.
- Preços dos planos.
