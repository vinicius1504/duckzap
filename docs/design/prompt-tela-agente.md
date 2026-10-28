# Prompt para gerar a tela "Agente de IA" (cole numa ferramenta de design com IA)

Copie tudo abaixo da linha.

---

Crie o design de UMA tela de um SaaS brasileiro de atendimento por WhatsApp com agente de IA: a tela de **configurar um agente de IA** ("Agentes → editar agente"). Quem usa é o dono ou administrador de uma pequena empresa, sem conhecimento técnico. A tela precisa ser agradável, calma e rápida de entender: o dono cola informações da empresa, a IA escreve o agente, ele **testa na hora** conversando com o agente e só então salva. Idioma: português do Brasil em todos os textos. Entregue desktop (1440 px), tablet (820 px) e celular (390 px), em tema claro e escuro.

## O que o produto é
DuckChat: o cliente final manda mensagem no WhatsApp, o agente de IA responde sozinho e chama uma pessoa da equipe quando precisa. A tela abaixo configura esse agente.

## Layout da tela
- **Cabeçalho do agente:** nome, etiqueta de situação (Ativo, Pausado, Inativo), o "trabalho" do agente (Atendimento, Agendamento, Follow-up) e os canais ligados (chips com o nome do WhatsApp). Ação principal à direita: **Salvar** (com o aviso "Alterações não salvas" quando houver).
- **Abas** (rolagem horizontal no celular):
  1. **Configuração simples** (a mais importante, aberta por padrão)
  2. **Prompt da empresa**
  3. **Dados da empresa**
  4. **Documentos**
  5. **Regras de resposta**
  6. **Follow-up**
  7. **Agenda**
  8. **Versões e ativação**
- **Simulador de conversa** fixo na coluna da direita no desktop (visível em todas as abas); no tablet e no celular vira um botão "Testar no simulador" que abre uma gaveta.

## Aba 1: Configuração simples (o coração da tela)
Duas zonas:
1. **Essencial (obrigatório, marcado com \*)**:
   - Finalidade, em escolha segmentada: Recepção e triagem · Vendas (SDR) · Suporte nível 1 · Agendamento, cada uma com uma linha de ajuda.
   - Nome do agente · Modo de interação (tom): Amigável · Formal · Direto.
   - **"Fale sobre sua empresa" \*** (área de texto grande, mín. 50 caracteres, contador, ajuda: "Cole o texto do seu site, Instagram, serviços, perguntas que os clientes fazem. Links não são lidos automaticamente").
   - **"O que você vende ou os serviços que oferece" \*** (mín. 10 caracteres).
2. **Interruptor "Modo avançado"** (liga/desliga, com ajuda "Mostra campos opcionais que deixam a IA mais precisa"). Ligado, mostra grupos de campos OPCIONAIS:
   - *Como a IA deve agir:* "O que a IA deve fazer?" e "O que a IA NÃO deve fazer?", cada um com **botões de sugestão** clicáveis (ex.: "Ser sempre cordial e prestativo", "Perguntar o nome do cliente no início", "Agendar reuniões com clientes interessados"; restrições: "Nunca mencionar preços", "Não usar gírias nem abreviações", "Não usar emojis", "Não pedir dados sensíveis como senha ou dados bancários", "Não dar informação médica ou jurídica").
   - *Sobre o negócio:* O que você NÃO vende · Formas de pagamento · Horário de atendimento · Localização · Como funciona o orçamento.
   - *Quando chamar uma pessoa:* Quando passar para uma pessoa · O que perguntar antes de transferir.
- Botão principal grande: **"Gerar com IA"** (vira "Gerar de novo" depois). Fica desabilitado com o motivo escrito embaixo ("Para gerar, ainda falta: Fale sobre sua empresa (faltam 12 caracteres)").
- **Estado "gerando" (leva de 20 s a 2 min):** painel de progresso honesto, sem porcentagem falsa, com frases que mudam ("Lendo as informações…", "Organizando o conhecimento…", "Escrevendo exemplos de resposta…"), tempo decorrido, aviso "pode levar até 2 minutos" e botão Cancelar. Os campos ficam travados mas visíveis.
- **Depois de gerar:** faixa "Nada foi salvo ainda — teste no simulador, ajuste e salve" e o bloco **"Complete para melhorar"**: uma lista curta só com o que faltou (ex.: "Formas de pagamento", "Localização"), cada item com um campo pequeno e o botão "Atualizar com estas informações". Se uma seção já tinha texto, perguntar por seção "Substituir / Manter".
- **Erros** (cada um com mensagem e ação): limite por minuto (contagem regressiva), orçamento mensal de IA esgotado (link "Ver planos"), serviço indisponível (botão "Tentar de novo", dados mantidos), campos inválidos marcados.

## Aba 2: Prompt da empresa (o que a IA usa como base)
Aviso no topo: "É isto que a IA usa como base. O que você escrever aqui vale nas conversas." Seções editáveis com contador de caracteres: **Comportamento** (descrição curta e instruções para o agente) e **Exemplos de resposta** (lista de pares "Cliente diz / Agente responde", de 8 a 12, com adicionar, remover e mover para cima ou para baixo). Botão "Como a IA recebe" abre uma prévia somente leitura do prompt completo montado.

## Aba 3: Dados da empresa
Três campos de texto editáveis: **Resumo da empresa**, **Produtos e serviços**, **Perguntas frequentes**.

## Aba 4: Documentos
Área de envio por arrastar e soltar (PDF, DOCX ou TXT, até 10 MB). Lista de documentos com situação: "Lendo…", "Lido pelo agente", "Falhou", e botão remover. Aviso: documentos são salvos na hora; os textos das outras abas ao clicar em Salvar.

## Aba 5: Regras de resposta
- **Quando o agente responde:** Sempre, em qualquer horário · Só fora do horário de atendimento · Só quando ninguém responder em 5 minutos.
- **Chamar uma pessoa quando** (caixas de seleção): o cliente pedir para falar com alguém · houver reclamação ou urgência · a pergunta não estiver no conhecimento do agente. Nota fixa: "Também chama uma pessoa se a IA tiver pouca certeza ou se uma ferramenta falhar duas vezes seguidas."
- **Jeito de responder:** controle deslizante de "Mais preciso" a "Mais criativo".
- **Limite de mensagens seguidas do agente** (número).

## Aba 6: Follow-up
Interruptor "Retomar conversas quando o cliente parar de responder". Sequência de etapas reordenáveis (cada etapa: tempo de espera, ex. "Após 2 h", "Após 24 h", "Após 3 dias", e a mensagem), adicionar e remover etapa, opção de respeitar o horário comercial e de parar quando o cliente responder. Estado vazio: "Nenhuma etapa — adicione a primeira retomada".

## Aba 7: Agenda
Interruptor "Este agente pode marcar horários na Agenda" e a lista de tipos de atendimento que ele pode marcar (caixas de seleção). Fica desabilitada sem o interruptor.

## Aba 8: Versões e ativação
- **Trabalho e canais:** informativo, com link "Mudar canais e equipes em Canais".
- **Ferramentas que a IA pode usar** (cada uma com interruptor e uma linha de explicação): Buscar no conhecimento · Ver horários livres · Marcar horário · Remarcar ou cancelar · Atualizar nome e e-mail · Mudar etapa do funil · Agendar retomada · Chamar uma pessoa (sempre ligada, travada).
- **Histórico de versões:** lista com data, quem salvou, resumo da mudança e botão "Voltar a esta versão" com confirmação.
- **Situação do agente:** botão **Ativar** ou **Pausar**, com o motivo claro quando a ativação estiver bloqueada (ex.: "Ligue o agente a um canal em Canais").
- **Cartão do Copiloto** (recurso do plano Empresarial): interruptor que faz a IA apenas sugerir respostas para a equipe, com avaliação de útil/ruim. Mostrar a versão "bloqueada por plano" com convite para conhecer o plano.

## Simulador (coluna direita)
Janela de conversa estilo WhatsApp para testar o agente sem enviar nada a clientes reais: balões do cliente e do agente, campo de mensagem, botão para reiniciar a conversa, indicação "Modo de teste: nada é enviado e nenhuma agenda é alterada". Usa a configuração que está na tela, mesmo sem salvar. Estado "digitando…" enquanto responde. Mostrar, de forma discreta, quando o agente chamou uma pessoa ou usou uma ferramenta.

## Estilo visual (siga estes tokens)
- Marca: **DuckChat**, amigável e confiável, nada infantil. Amarelo-pato como cor de destaque e tinta azul-petróleo escura para texto e navegação.
- **Tema claro:** fundo `#F6F7F4`, cartões `#FFFFFF`, cartão secundário `#EAEEF0`, linhas `#E3E8EB`, texto `#0F1F2B`, texto secundário `#566672`, destaque (botão principal, foco, selecionado) amarelo `#FFC42E` com texto `#0F1F2B`, destaque forte `#E9AA05`, sucesso `#17794F`/fundo `#E2F3EA`, alerta `#7A4F00`/fundo `#FFF0C7`, erro `#B3261E`/fundo `#FCE7E5`, informação `#1D5F8A`/fundo `#E2EFF8`.
- **Tema escuro:** fundo `#0B151D`, cartões `#13212C`, secundário `#1C2E3B`, linhas `#26394A`, texto `#E8EEF1`, texto secundário `#A3B4BF`, foco amarelo `#FFC42E`.
- Fonte Plus Jakarta Sans (pesos 400 a 800). Cantos arredondados médios, sombras muito suaves, bastante respiro, ícones de traço simples (Lucide).
- Menu lateral à esquerda, escuro (`#0F1F2B`), com ícones, que vira barra de abas inferior no celular.

## Qualidade que importa
- Hierarquia clara: o olhar vai primeiro para o essencial e para o botão "Gerar com IA"; o resto é secundário.
- Acessibilidade: contraste mínimo AA, alvos de toque de 44 px no celular, foco visível, todo campo com rótulo, estados anunciados (carregando, erro, sucesso).
- Mostre TODOS os estados importantes: padrão, essencial incompleto, gerando, gerado com "Complete para melhorar", erro, alterações não salvas, e o dialogo de "Substituir / Manter".
- Sem nomes de empresas reais. Exemplo de empresa para os textos: "Nexora Tecnologia", suporte técnico de TI, criação de sites e automação de WhatsApp.

## O que entregar
1. A tela completa, desktop com a aba "Configuração simples" e o simulador.
2. As variações de estado listadas acima.
3. As abas "Prompt da empresa" e "Versões e ativação" em desktop.
4. Tablet e celular com a gaveta do simulador.
5. Os dois temas.
