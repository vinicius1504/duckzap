# Contrato do back (front ↔ API)

Cada função abaixo existe em `features/<módulo>/api.ts`, com o mesmo nome e os mesmos tipos (`packages/contracts/src/<módulo>.ts`), e **hoje chama a API real** (`apps/api`, rotas `/v1/...`) com `apiFetch`/`callApi`. As telas não mudam quando a rota muda. Única exceção: os passos de WhatsApp e agente do cadastro (ver a seção de pendências).

Erros da API têm sempre o formato `{ error: { code, message } }` (mensagem em pt-BR); erro de validação é `422` com `code: "validation_error"`, `message` no formato `Campo "telefone": …` e `fields` (mapa campo → mensagem).

Ordem sugerida (segue o roadmap §8): auth → equipe/canais → conversas → clientes → agenda → agentes → campanhas → ajustes/cobrança → admin.

## apps/web

| Módulo | Funções |
|--------|---------|
| auth | `signIn`, `getSessionByToken`, `requestPasswordReset` |
| shell | `getShellStatus` (status dos canais + notificações) |
| home | `getHomeOverview(period)`, `createTask`, `setTaskDone` |
| conversations | `getInboxLookups`, `listConversations(filters, viewer)`, `getConversation(id, viewer)`, `markConversationRead`, `assumeConversation`, `transferConversation`, `setConversationMode`, `resolveConversation`, `reopenConversation`, `moveConversationStage`, `setContactTags`, `sendMessage`, `resendMessage`, `suggestReply`, `rateSuggestion`, `scheduleFollowUp`, `setFollowUpPaused`, `cancelFollowUp`, `scheduleAppointment`, `updateContactNotes`, `setContactTaskDone` |
| contacts | `listContacts(query)`, `getContact`, `listContactOptions`, `listContactOwners`, `createContact`, `updateContact`, `deleteContacts`, `addContactNote`, `tagContacts`, `addContactsToList`, `listTags`, `createTag`, `updateTag`, `reorderTags`, `deleteTag`, `listContactLists`, `createContactList`, `deleteContactList`, `previewImport`, `commitImport`, `exportContacts`, `getInviteOverview`, `inviteContacts` |
| appointments | `listAppointments(range)`, `listAppointmentsForContact`, `getAppointment`, `findAppointmentConflicts`, `createAppointment`, `updateAppointment`, `setAppointmentStatus`, `listAppointmentTypes`, `createAppointmentType`, `setAppointmentTypeActive`, `listAgendaOwners`, `getCalendarSync`, `syncCalendarNow`, `setCalendarConnected`, `getReminderSettings`, `updateReminderSettings` |
| campaigns | `listCampaigns`, `getCampaign`, `listCampaignHistory`, `listCampaignRecipients`, `listRejectedRecipients`, `listAudiences`, `listSendingChannels`, `listCampaignTemplates`, `getCampaignTerms`, `acceptCampaignTerms`, `createCampaignDraft`, `updateCampaignDraft`, `deleteCampaignDraft`, `generateVariations`, `launchCampaign`, `pauseCampaign`, `resumeCampaign`, `cancelCampaign`, `duplicateCampaign`, `saveCampaignTemplate`, `deleteCampaignTemplate` |
| agents | `listAgents`, `getAgent`, `listAgentChannels`, `listAppointmentTypes`, `listAgentVersions`, `getCopilotOverview`, `getAgentPlanUsage`, `createAgent`, `updateAgentConfig` (cria versão), `rollbackAgentVersion`, `setAgentStatus`, `uploadAgentDocument`, `removeAgentDocument`, `simulateAgentReply`, `setCopilotEnabled` |
| channels | `getChannelsOverview`, `createChannel`, `startQrSession`, `getQrSession`, `getOfficialWebhookInfo`, `connectOfficialChannel`, `authorizeInstagram`, `disconnectChannel`, `setDefaultChannel`, `updateChannelSettings`, `deleteChannel`, `assignTeamChannels` |
| team | `getTeamOverview`, `inviteMember`, `resendInvite`, `cancelInvite`, `updateMember`, `resetMemberPassword`, `setMemberActive`, `createTeam`, `updateTeam`, `deleteTeam` |
| settings | `getPlan`, `getPlanCatalog`, `getCompany`, `updateCompany`, `getServiceSettings`, `updateServiceSettings`, `getIntegrations`, `connectGoogleCalendar`, `disconnectGoogleCalendar`, `authorizeInstagramIntegration`, `updateWhatsappOfficialToken`, `listApiKeys`, `createApiKey`, `revokeApiKey`, `listWebhooks`, `createWebhook`, `testWebhook`, `setWebhookActive`, `deleteWebhook`, `getBilling`, `requestPlanChange`, `getAccount`, `updateProfile`, `changePassword`, `startTwoFactorSetup`, `confirmTwoFactor`, `disableTwoFactor`, `updateNotifications` |
| help | `getHelpCenter` (`GET /v1/help?q=`), `askHelpAssistant` (`POST /v1/help/ask`, IA tier fast; sem IA responde por palavras-chave), `createSupportTicket` (`POST /v1/support/tickets`, e-mail para `SUPPORT_EMAIL`), `restartProductTour` (`POST /v1/me/tour/restart`) |
| onboarding | `createSignUp`, `getDraft`, `getStepDefaults`, `saveCompany`, `startQrSession`, `getQrSession`, `connectOfficialApi`, `skipWhatsapp`, `simulateAgentReply`, `getSampleConversation`, `completeOnboarding` |

Regras puras já prontas para o worker reutilizar (em `contracts/campaigns.ts`): `warmupDailyLimit`, `splitIntoDays`, `scheduleDays`, `estimateDaySeconds`, `validateVariation`, `textSimilarity`. Permissões: `contracts/permissions.ts` (`can`).

## Modo de resposta do canal (`replyMode`)

`channels.reply_mode` (migration `0007_reply_mode`), em `Channel.replyMode` e opcional em `PATCH /v1/channels/{id}` (ausente = mantém):

- `ai` (padrão, "Somente IA"): o sistema **nunca** manda boas-vindas nem aviso de fora do horário; quem cumprimenta é o agente. Os textos continuam guardados (trocar o modo não apaga nada), só não são enviados.
- `auto` ("Automático, sem IA"): manda as mensagens automáticas (`decideAutoMessage`) e **conversas novas** do canal nascem em modo humano, na fila da equipe (`initialConversationMode`); conversas que já existem não mudam.

As respostas obrigatórias do sistema (confirmação de SAIR/consentimento e resposta a lembretes de agendamento) saem em qualquer modo. Canais existentes ficam em `ai`. `teams.greeting`/`teams.out_of_hours_message` e `organization_settings.welcome_message` seguem no banco e nos contratos (opcionais), mas **nenhum envio os usa** e as telas de Equipe e Cadastro não os pedem mais.

## Assinatura das mensagens de pessoa (`signMessages`)

`channels.sign_messages` (migration `0008_sign_messages`, padrão `true`), em `Channel.signMessages` e opcional em `PATCH /v1/channels/{id}` (ausente = mantém). Ligada, toda mensagem de **pessoa** enviada por um canal de WhatsApp sai para o cliente como `*Rafael (Vendas):*` + quebra de linha + o texto (primeiro nome de quem enviou e nome da equipe da conversa; negrito do WhatsApp). Regras:

- A assinatura é aplicada em `deliverOutbound` (`conversations/outbound.ts`, função pura em `conversations/signature.ts`) **só no que vai ao provedor**: o histórico, a prévia da lista e as métricas guardam apenas o que a pessoa digitou.
- Nunca assina mensagens da IA, avisos automáticos do sistema e notas internas; não assina canal de Instagram (sem negrito). Legenda de imagem/documento também é assinada; áudio não tem texto.
- Reenviar uma mensagem que falhou mantém o remetente original (reenviar uma da IA não a transforma em mensagem de pessoa).

## Agendamento é função do sistema (não de cada agente)

Qualquer agente que esteja atendendo (ao vivo, Copiloto e simulador) vê horários, marca e remarca, sem ligar nada no agente. A disponibilidade é **derivada da empresa do tenant**: se ela tem ao menos um tipo de atendimento **ativo** na Agenda (e que não seja "só a equipe marca"), o runtime expõe `list_available_slots`, `book_appointment`, `reschedule_appointment` (e `cancel_appointment`, que acompanha a remarcação) com TODOS esses tipos. Sem nenhum, as ferramentas de agenda não existem e a IA não tem como marcar.

**Como a IA agenda (roteiro no prompt, regra 12 de `SCHEDULING_RULES`, só quando há agenda):** tipo (só pergunta se houver mais de um) → **janela** (pergunta data, semana ou mês e manhã/tarde antes de consultar; só o mês → pergunta a semana; sem preferência → próximos 7 dias) → nome (se o cadastro só tem o telefone) → horários (no máximo 3 opções, com dia da semana, data e hora) → o cliente escolhe → marca → o agendamento já nasce **CONFIRMADO** (o cliente combinou o horário na conversa; `bookAppointment` chama `setAppointmentStatus(…, "confirmed")` logo após criar, e remarcar também confirma). Se essa confirmação não passar, fica **pendente** e a ferramenta diz isso à IA, que avisa o cliente que a equipe confirma. Garantias que NÃO dependem do modelo lembrar:

- `book_appointment` recusa quando o cadastro não tem nome de verdade (`hasRealName`: telefone, vazio e "sem nome" não valem) e manda a IA perguntar e salvar com `update_contact_fields`, que a agenda derivada também libera (`GRANTED_TOOLS`).
- **Horário sempre local:** `TurnInput.timeZone` (ao vivo: o da empresa) vira "quinta-feira, 29/10 às 14:00" em `<agora>`, nos agendamentos do cliente (com o nome do tipo) e em todas as respostas das ferramentas (`conversations/../agents/local-time.ts`). O `slot_id` continua com o instante em UTC, mas é só identificador.
- **Consulta dirigida e enxuta:** `list_available_slots` aceita `from_time`/`to_time` (HH:MM locais), recusa janela de mais de 14 dias (a mensagem manda perguntar a semana) e devolve no máximo 8 horários espalhados: 1 dia → vários horários do dia; uma semana → o primeiro de cada dia, com o aviso "N de M horários livres".

- Função pura `effectiveSchedulingConfig(config, bookableTypeIds)` (`packages/ai/src/agents/scheduling.ts`, com `bookableTypeIds(types)`), aplicada ANTES de montar o turno nos três caminhos: turno ao vivo e Copiloto (`conversations/ai-turn.ts`, tipos lidos da própria empresa dentro de `withOrg`) e simulador (`agents/simulate.ts`, tipos ativos da empresa). Conversa sem agente (assistente genérico do "sugerir resposta") continua sem ferramentas.
- **Legado ignorado** (continua válido no schema; nada é apagado nem migrado): `config.scheduling.canBook`, `config.scheduling.appointmentTypeIds` e a presença de `list_available_slots`/`book_appointment`/`reschedule_appointment` em `advanced.tools`. `PUT /v1/agents/:id/config` deixou de validar `appointmentTypeIds` (antes 422 `appointment_type_invalid`/`appointment_type_staff_only`), porque o valor não é mais usado.
- Guardrails intactos: a IA só usa tipos ativos da própria empresa, só mexe em agendamentos do próprio cliente (`assertScope`/`ownAppointment`), conflito de horário é recusado, o agendamento nasce CONFIRMADO (`source: ai_agent`; cai para PENDENTE só se a confirmação falhar) e Copiloto/simulador nunca gravam.
- Finalidade `scheduling` do gerador e job `scheduling` seguem aceitos pelos schemas (dados salvos e chamadas antigas), mas a UI não oferece mais "Agendamento". O meta-prompt do gerador não pede configuração de agenda nem avisos sobre ela.

## Gerador de perfil do agente (`POST /v1/agents/generate`)

Dados da empresa entram, conteúdo EDITÁVEL do agente sai. **Não grava nada** (sem estado): o dono revisa e salva pelas rotas de sempre (`POST /v1/agents`, `PUT /v1/agents/:id/config`). Permissão `agent.manage`; conta suspensa = 403 como nas demais rotas.

- Corpo (`agentGeneratorInputSchema`, `contracts/agents.ts`): `purpose` (`reception` | `sales` | `support` | `scheduling`), `agentName`, `tone`, `companyText` (texto colado, até 20 mil caracteres; só TEXTO, links não são abertos), e opcionais curtos: `sells`, `doesNotSell`, `paymentMethods`, `hours`, `location`, `budgetProcess`, `askBeforeHandoff`, `handoffRules`, `restrictions`, `customInstructions`. É preciso `companyText` (20+ caracteres) ou `sells`.
- Resposta 200 (`agentGeneratorOutputSchema`): `description` → `profile.description`; `instructions` → `advanced.prompt` ("Objetivos e instruções": papel, condução, saudação, despedida, quando transferir; **sem restrições**); `restrictions` → `advanced.restrictions` ("Restrições": o que a IA nunca deve fazer, em lista; junta as do dono com as que decorrem dos dados; nunca vazio na prática, ao menos as de segurança de negócio; padrão `""` se o modelo omitir); `companyInfo` → `knowledge.companyInfo` ("Informações da empresa": UM texto em markdown simples, até 12 mil caracteres, com seções `## Sobre a empresa`, `## O que oferece`, `## O que NÃO oferece` (só se constar), `## Formas de pagamento`/`## Horários`/`## Localização`/`## Como funciona o orçamento` (só se constarem) e `## Perguntas frequentes` com `P:`/`R:`); `companySummary` → `profile.companySummary` (resumo de 1 a 3 frases); `examples` (8 a 10 `{customer, agent}`) → `knowledge.examples` (opcional, máx. 12); `warnings` (notas livres sobre o que faltou); `missingFields` (opcional; veja abaixo). `productsAndServices` e `faq` seguem no schema só por compatibilidade (opcionais, padrão `""`; o gerador atual os devolve vazios). Os limites de tamanho são os de `agentConfigSchema`: dá para salvar o que veio.
- Configuração do agente, campos novos (opcionais; configs antigas continuam válidas): `knowledge.companyInfo` (até 12 mil) e `advanced.restrictions` (até 3 mil). No prompt do agente (`buildSystemPrompt`): `companyInfo` entra em `<conhecimento>` como "Informações da empresa:" e conta como conhecimento estático (aterramento da resposta e conferência de preços e links); `restrictions` entra no bloco de persona/negócio como "Restrições da empresa (o que NUNCA fazer):", **fora** das "REGRAS INVIOLÁVEIS" e de `buildRulesBlock` (o conteúdo é do negócio e pode ser citado; a detecção de vazamento do prompt não muda). `productsAndServices`/`faq` legados continuam sendo incluídos quando existem. O resumo da versão cita "informações da empresa" e "restrições" quando mudam.
- `missingFields` (opcional; ausente = sem lista): subconjunto de `sells | doesNotSell | paymentMethods | hours | location | budgetProcess | handoffRules` com o que está ausente de TODOS os dados (texto colado e campos). O meta-prompt pede a lista ao modelo (junto de `warnings`, que fica para notas não estruturadas e não repete esses itens); o código descarta chaves desconhecidas e repetidas e **nunca lista um campo que o corpo já trouxe preenchido** (`dropFilledMissingFields`). A tela mostra um campo para cada chave e regera com o corpo original + esses campos.
- `config.generator` (opcional, em `agentConfigSchema` e no tipo de runtime do `@duckzap/ai`): o formulário do gerador guardado junto da config do agente, versionado com ela (`PUT /v1/agents/:id/config` aceita e persiste; configs antigas sem ele continuam válidas). Campos: `purpose`, `companyText` (até 20 mil) e os opcionais do corpo (`sells`, `doesNotSell`, `paymentMethods`, `hours`, `location`, `budgetProcess`, `askBeforeHandoff`, `handoffRules`, `restrictions`, `customInstructions`), com os mesmos limites da entrada (uma só definição no contrato). Nome e tom não entram: ficam em `name` e `profile.tone`. **Nunca vai para o prompt do modelo**: `buildSystemPrompt` só lê os campos gerados; o simulador e o runtime o ignoram. Tipo exportado: `AgentGeneratorStored`.
- Erros `{ error: { code, message } }`, pt-BR: `invalid_input` 422 (com `fields`), `rate_limited` 429 (por empresa, `AGENTS_GENERATOR_PER_MINUTE`, padrão 5), `budget_exceeded` 402 (orçamento mensal de tokens do plano), `ai_unavailable` 503 (provedor passageiro, já repetido), `generation_failed` 502 (resposta inválida mesmo após uma nova tentativa, ou erro permanente do provedor).
- IA: `tier: "smart"`, `purpose: "agent_generator"` em `ai_usage_log` (também quando falha depois de gastar tokens). A chamada leva até ~2 min (saída longa, `timeoutMs` próprio na requisição ao modelo): o front deve mostrar progresso e não depender de timeout curto.
- Constantes para a tela: `AGENT_RESTRICTION_SUGGESTIONS`, `AGENT_OBJECTIVE_SUGGESTIONS`, `AGENT_GENERATOR_PURPOSE_LABELS`.

## Importar do WhatsApp (Clientes)

Traz as pessoas que o WhatsApp conectado a um canal **QR Code (Evolution)** conhece (agenda do aparelho). A pessoa revisa a lista e conclui pelos MESMOS passos da planilha (origem obrigatória, etiquetas, lista, confirmação de relação, dedupe por telefone). Contratos: `contracts/contacts.ts`, seção "Importação do WhatsApp". Permissão `contact.import` (atendente: 403), conta suspensa = 403 `account_suspended` como nas demais rotas.

- `POST /v1/contacts/import/whatsapp/preview` · corpo `{ channelId }` → `whatsappImportPreviewSchema` (`importId`, `channelId`, `channelName`, `candidates[{ phone (E.164), name, existing }]`, `summary`). Chamada pesada ao provedor (milhares de itens, prazo de até 60 s): **6 por minuto por empresa** (`WHATSAPP_PREVIEWS_PER_MINUTE`), excesso = `429 rate_limited` (com `retryAfterSeconds`). Grava a lista em `contact_imports` (a mesma tabela da planilha; `rows = [{ Nome, Telefone }]`, `fileName = "WhatsApp · {nome do canal}"`, validade de 1 h); esse nome vira o título do evento "Importado de WhatsApp · {canal}" na linha do tempo de quem for criado.
- `POST /v1/contacts/import/whatsapp/commit` · corpo `whatsappImportCommitSchema` (`importId`, `rows[{ phone, name }]`, `origin`, `originNote`, `confirmedRelationship: true`, `tagIds`, `listId`) → `importResultSchema` (`{ created, updated, skipped[{ row, reason }] }`). `skipped[].row` é a posição (1, 2, 3…) do contato na seleção enviada; hoje o único motivo é `duplicate` (telefone repetido na seleção ou criado por outra requisição no meio).
- **Só telefones da prévia**: todo `rows[].phone` precisa estar, exatamente como veio (`+` e dígitos), na lista guardada daquela prévia. Qualquer outro derruba o pedido inteiro com `422 invalid` **sem consumir** a importação (a pessoa pode corrigir e reenviar). O servidor nunca importa número que não veio do WhatsApp do canal. Uma importação de planilha não serve neste endpoint.
- Nome corrigido na revisão é gravado (aparado, até 120); vazio vira "Sem nome", como na planilha. Quem já é cliente (mesmo telefone) é atualizado (etiquetas, lista, campos vazios), nunca duplicado e o nome já cadastrado não é sobrescrito. Uso único: confirmar de novo ou depois de 1 h = `404 not_found`.
- `summary`: `found` = itens que o WhatsApp devolveu; `people` = candidatos finais; `existing` = candidatos que já são clientes; `groups` e `hidden` (IDs ocultos `@lid`, sem número) ficam de fora; `other` = transmissão/status, número inválido, o próprio número do canal e repetidos; `noName` = candidatos sem nome útil. Vale `found = people + groups + hidden + other`.
- Telefone = `+` + dígitos do JID, a mesma forma que a entrada de mensagens grava em `contacts.phone` (JIDs brasileiros antigos têm 12 dígitos, sem o 9º; o dedupe é por telefone exato). Nome = `pushName` aparado; vira vazio se for só dígitos/símbolos de telefone (igual ao número). Candidatos ordenados por nome, sem nome no fim.
- Erros `{ error: { code, message } }` (pt-BR): `channel_not_found` 404 (id inválido ou de outra empresa), `channel_unsupported` 422 (não é WhatsApp QR: Meta Cloud e Instagram não têm lista de contatos), `channel_disconnected` 409 (canal desconectado, ou o provedor diz que o número saiu), `provider_unavailable` 502 (Evolution fora do ar/lenta), `too_large` 413 (mais de `WHATSAPP_IMPORT_MAX_ROWS` = 20 mil candidatos), `not_found` 404 (importação expirada, já usada ou de outra empresa), `invalid` 422 (telefone fora da prévia, etiqueta ou lista inexistente), `validation_error` 422, `rate_limited` 429.
- Provedor: método opcional `listContacts?(channel): Promise<ProviderContact[]>` em `MessagingProvider` (`lib/messaging.ts`); Evolution: `POST /chat/findContacts/{instância}` com `{ where: {} }`. Os campos `isSaved`/`type` da Evolution vêm iguais para todos e não entram na classificação. Nomes e números nunca vão para log. Teste manual: `pnpm --filter @duckzap/api whatsapp:smoke` (só imprime contagens).

## Notificações (o sino do topo)

Contrato: `packages/contracts/src/notifications.ts`; evento `notifications.invalidate` em `realtime.ts`. Tabela `notifications` (uma linha por pessoa que deve ficar sabendo, com RLS por empresa).

| Rota | O que faz |
|------|-----------|
| `GET /v1/notifications` | `{ items, unreadCount }`: SÓ as da pessoa logada, até 30, mais novas primeiro (lidas e não lidas); `unreadCount` é o total de não lidas dela (pode passar de 30). Só exige sessão. |
| `POST /v1/notifications/read` | Body `{ all: true }` ou `{ ids: [...] }` → `{ ok: true, unreadCount }`. Marca só as da própria pessoa; id de outra pessoa/empresa ou malformado é ignorado em silêncio (200, sem revelar existência). Idempotente: repetir não muda o carimbo de leitura. |

**Primeira notificação: a IA mexeu na agenda** (`appointment_booked` | `appointment_rescheduled` | `appointment_canceled`), gravada pelas portas da IA ao vivo (`conversations/ai-ports.ts`) depois que o agendamento foi salvo, na MESMA transação.
- Título: "{agente} marcou/remarcou/cancelou um agendamento". Corpo: "{cliente} · {tipo} · {dia da semana, DD/MM às HH:MM no fuso da empresa}" (horário novo ao remarcar; horário cancelado ao cancelar; " · pendente de confirmação" só se a confirmação falhou). Cliente = nome do cadastro (ou o telefone, se o cadastro só tem ele). `link` = `/conversas?conversa={id da conversa}`.
- Quem recebe: (a) membros ATIVOS da equipe da conversa; (b) o responsável pelo agendamento, se ainda ativo; (c) se a conversa não tem equipe, ou a equipe não tem ninguém ativo, os proprietários e administradores ativos da empresa (além do responsável). Nunca gente de outra empresa; convites pendentes e pessoas inativas ficam de fora.
- Tempo real: UM `notifications.invalidate` por ação (não por pessoa), publicado só depois do commit; o evento não diz de quem nem do quê, cada sino busca a lista pela API.
- Garantias: o aviso roda num savepoint; se falhar, o agendamento é mantido, o evento não sai e o erro vai para o log (só o nome do erro, sem dado pessoal). Copiloto e simulador não gravam (as ferramentas de escrita ficam em dry-run; o simulador usa portas em memória).
- Retenção: ao gravar, apaga até 50 notificações já LIDAS há mais de 60 dias da empresa (sem job novo); não lidas nunca são apagadas.
- Para novos tipos de aviso: `notifyMembers(tx, organizationId, userIds, { kind, title, body, link })` em `modules/notifications/service.ts` (dedupe de ids, lista vazia não faz nada) e acrescente o `kind` no contrato.

## apps/admin (rotas `/v1/admin/*`, papel de banco separado)

| Módulo | Funções (⚑ = grava em `audit_logs` na mesma transação) |
|--------|---------|
| auth | `startSignIn`, `getChallenge`, `verifyTwoFactor` (2FA obrigatório), `getSessionByToken`, `signOut` — logar tentativas e aplicar rate limit |
| overview | `getPlatformOverview` |
| companies | `listCompanies`, `getCompanyCounts`, `getCompanyDetail`, `changeCompanyPlan` ⚑, `extendCompany` ⚑, `setCompanyEnabled` ⚑ |
| subscriptions | `listSubscriptions`, `getSubscriptionCounts`, `getSubscription`, `listInvoices` |
| plans | `listPlans`, `createPlan` ⚑, `updatePlan` ⚑, `deletePlan` ⚑ |
| audit | `listAuditEntries` |

## Pendências conhecidas

- **Onboarding (`/comecar`)**: o cadastro da conta e da empresa é real (Better Auth + `POST /v1/onboarding/organization`). Continuam em memória do servidor do front: `startQrSession`, `getQrSession`, `connectOfficialApi`, `skipWhatsapp`, `simulateAgentReply`, `getSampleConversation` e `completeOnboarding` (agente de teste). É decisão de produto: no cadastro a empresa ainda não tem canal nem agente reais; ligar exige criar o canal/agente a partir do rascunho (Canais e Agentes já têm as rotas).
- **Ajuda**: FAQ, vídeos e textos do assistente vêm de `apps/api/src/modules/help/content.ts` (versionado no código). Os links `[LINK]` (WhatsApp do suporte, termos, privacidade, vídeos) ainda precisam ser definidos. Chamados saem por e-mail para `SUPPORT_EMAIL` (sem tabela); `POST /v1/me/tour/restart` só registra.
- Upload de arquivos (conhecimento dos agentes, logo da empresa) ainda não guarda o arquivo; no back, upload direto ao R2 por URL assinada.
- Permissões sem entrada própria na matriz (os módulos usaram a mais próxima): resolver conversa, gerenciar etiquetas e listas, configurar tipos de atendimento e lembretes.
- Tarefas de fundo (campanhas, IA vencida, reprocessar webhooks) rodam **dentro da API** (`apps/api/src/jobs.ts`) até existir o `apps/worker` com BullMQ.

