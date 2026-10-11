# Studio MCP oficial e Blender lideram a criação 3D com Claude no Roblox

_Pergunta: Quais técnicas novas os profissionais estão usando com o Claude (skills e servidores MCP) para criar modelos 3D e builds melhores no Roblox Studio, nos últimos 30 dias?_  
_Gerado em 2026-10-11 pelo Trawl 0.1.0 · profundidade standard_

> **Verificação:** 10 achados conferidos na fonte original: 9 confirmado(s), 1 corrigido(s), 0 sem prova, 0 falso(s).

Nos últimos 30 dias, quem produz de verdade com o Claude no Roblox liga o Claude Code ao servidor MCP que já vem embutido no Roblox Studio e carrega o conhecimento de Roblox por skills [[1]](https://create.roblox.com/docs/en-us/studio/mcp.md)[[2]](https://devforum.roblox.com/t/4894055)[[3]](https://www.youtube.com/watch?v=afuKhenJldY). Para modelos 3D há dois caminhos. O primeiro são as ferramentas nativas desse MCP: malha texturizada a partir de texto, modelos procedurais de peças primitivas com imagem de referência e materiais gerados, reforçados em 23/09 por texturas melhores, divisão de malhas em partes e prévia em imagem [[1]](https://create.roblox.com/docs/en-us/studio/mcp.md)[[4]](https://devforum.roblox.com/t/4890084). O segundo é o fluxo da comunidade, em que o Claude dirige o Blender e geradores externos, reduz os triângulos, confere com uma prévia renderizada e só então sobe o modelo [[3]](https://www.youtube.com/watch?v=afuKhenJldY)[[5]](https://github.com/S4US/Roqer). O que segue em disputa é a qualidade final: não existe comparação séria entre os dois caminhos, e parte da comunidade chama esses jogos de slop [[6]](https://www.reddit.com/r/aigamedev/comments/1x0k32m/built_an_age_of_sail_strategy_game_with_claude). Alerta prático: o Claude Code 2.1.281 em diante perde as ferramentas do MCP oficial do Studio [[7]](https://devforum.roblox.com/t/roblox-studio-mcp-works-up-to-claude-code-21280-broken-from-21281/4896239)[[8]](https://github.com/anthropics/claude-code/issues/97319).

## O MCP embutido no Studio virou o centro de tudo

O Roblox Studio traz um servidor MCP local, via stdio, que se liga em Assistant > Manage MCP Servers e tem quick connect para o Claude Code, o Codex, o Cursor e outros clientes [[1]](https://create.roblox.com/docs/en-us/studio/mcp.md). A página oficial, atualizada em 08/10, lista ferramentas para ler e editar scripts, explorar a árvore do jogo, rodar Luau, controlar o playtest, capturar a tela e simular teclado, mouse e movimento do personagem [[1]](https://create.roblox.com/docs/en-us/studio/mcp.md). Essa base vem de uma atualização de fevereiro que acrescentou as ferramentas de playtest e passou a aceitar modelos da Anthropic, da OpenAI e do Google no Assistant, com a promessa de ligar o Assistant a MCPs de terceiros como Blender e Figma [[9]](https://devforum.roblox.com/t/4415631)[[10]](https://www.moguravr.com/roblox-studio-mcp-server-agentic-update). A própria documentação avisa que um cliente MCP lê e altera os places abertos, então só vale conectar o que for de confiança [[1]](https://create.roblox.com/docs/en-us/studio/mcp.md).

## O próprio Studio já gera malhas, modelos procedurais e texturas

A técnica mais nova não depende de nada externo: o MCP oficial tem generate_mesh, que gera uma malha 3D texturizada a partir de texto, generate_procedural_model, que monta o objeto com peças primitivas e aceita imagem de referência e esquema de peças, e generate_material para variantes de material, além de busca e inserção de assets da Creator Store [[1]](https://create.roblox.com/docs/en-us/studio/mcp.md). Em 23/09 o Roblox somou texturas geradas melhores, inclusive em modelos já existentes pelo comando /generate_texture, o /segment_mesh, que divide uma malha importada em até cinco partes nomeadas, e prévia em imagem antes de gerar [[4]](https://devforum.roblox.com/t/4890084). O próprio Roblox diz que a textura gerada é ponto de partida, para refinar depois em software de texturização [[4]](https://devforum.roblox.com/t/4890084). Combinando isso com screen_capture e o subagente de playtest, o Claude consegue gerar, olhar o resultado no viewport e corrigir sem você no meio [[1]](https://create.roblox.com/docs/en-us/studio/mcp.md).

## Na comunidade, o Claude dirige o Blender e confere antes de importar

O fluxo mais assistido do mês é o do SyphoDev, num vídeo de 04/10 com mais de 91 mil views: Claude Code com Opus 5.5 e skills, o MCP do Studio, Flux no Cloudflare Workers AI para imagens e ícones, Hi3DGen numa GPU grátis do Kaggle para os modelos, Blender para caber no limite de triângulos do Roblox e a API Open Cloud para subir tudo [[3]](https://www.youtube.com/watch?v=afuKhenJldY). O mesmo autor liberou em 07/10 o pacote de skills com roblox-3d-model, que leva texto ou imagem a um MeshPart pronto via Blender, e um orquestrador que roda os estágios em subagentes [[11]](https://github.com/SyphoDev-yt/roblox-ai-skills). O Roqer, criado em 25/09, faz o mesmo dentro de um agente próprio: modela no Blender o que Parts não resolvem, confere cada modelo com um render de prévia e sobe para o jogo [[5]](https://github.com/S4US/Roqer). Há relatos de jogos inteiros com modelos e animações feitos assim, como um jogo naval com 4.600 marinheiros simulados [[6]](https://www.reddit.com/r/aigamedev/comments/1x0k32m/built_an_age_of_sail_strategy_game_with_claude). Criadores grandes usam APIs de imagem e vídeo para capa, ícone e trailer, não para os modelos do jogo [[12]](https://www.youtube.com/watch?v=yzBTQRfAdOk).

## Skills levam o conhecimento de Roblox, mas escolha a dedo

O conhecimento que o modelo não tem chega por skills. A roblox-brain tem 29 skills, cada uma com um SKILL.md curto e uma referência longa aberta só quando a tarefa pede, o que economiza contexto [[2]](https://devforum.roblox.com/t/4894055). A roblox-dev-skill fixa a versão da API do motor e avisa quando o dump local envelhece, porque o Roblox muda toda semana [[13]](https://github.com/MSayib/roblox-dev-skill). Na janela também surgiram pacotes novos para assets, mapas e interface vinda do Figma [[11]](https://github.com/SyphoDev-yt/roblox-ai-skills)[[14]](https://github.com/EL4CTEO/roblox-skills)[[15]](https://github.com/xtrair/figma-to-roblox-ui), e o robloxstudio-mcp segue ativo, mas focado em debug e testes, não em modelagem [[16]](https://github.com/Chrrxs/robloxstudio-mcp). Cuidado com repositórios de estrelas compradas que aparecem nessas buscas, como RobloxForge-Intelligence e Roblox-Live-Bridge-MCP: mesmas 70 estrelas, nenhum fork, código só HTML e criados no mesmo dia [[17]](https://github.com/AallamR/RobloxForge-Intelligence)[[18]](https://github.com/adamenrem-jpg/Roblox-Live-Bridge-MCP).

## Antes de adotar: o Claude Code 2.1.281 em diante quebra a conexão

Desde a versão 2.1.281 o Claude Code conecta no MCP oficial do Studio mas fica com zero ferramentas, porque rejeita dois campos novos (ttlMs e cacheScope) na lista de ferramentas do protocolo 2026-07-28; até a 2.1.280 funcionava, e a issue no repositório do Claude Code segue aberta [[7]](https://devforum.roblox.com/t/roblox-studio-mcp-works-up-to-claude-code-21280-broken-from-21281/4896239)[[8]](https://github.com/anthropics/claude-code/issues/97319). O Codex mostra o mesmo erro [[19]](https://devforum.roblox.com/t/codex-mcp-server-bug/4898883). Também aparecem erros de permissão ao dar require em módulos, conexões que caem e uma feature flag liberada sem aviso que mudou o que o MCP podia fazer [[20]](https://devforum.roblox.com/t/capabilities-error-on-requiring-some-modules-with-mcp/4908470)[[21]](https://devforum.roblox.com/t/mcp-frequently-dropping-connections-and-not-listing-all-or-any-open-instances/4737086)[[22]](https://devforum.roblox.com/t/unannounced-or-at-least-not-easily-discoverable-capabilities-feature-flag-bricks-astra/4872775). Sobre qualidade, a evidência é fraca dos dois lados: um teste informal com 14 modelos reconstruindo fotos no Blender não deu o primeiro lugar ao Claude [[23]](https://www.reddit.com/r/ChatGPT/comments/1wvqlwh/i_asked_14_ai_models_to_rebuild_this_photo_in).

## O que a comunidade diz

_Engajamento mede atenção, não verdade. Use como sinal de opinião e experiência de uso._

- YouTube (SyphoDev) · 91.5k views · 2026-10-05: [How to Make a Roblox Game With AI (Claude Opus 5.5 Full Tutorial)](https://www.youtube.com/watch?v=afuKhenJldY)
- YouTube (Cole) · 69.1k views · 2026-09-30: [Claude Opus 5.5 + Roblox Studio is Insane (Higgsfield API)](https://www.youtube.com/watch?v=yzBTQRfAdOk)
- r/aigamedev · ▲76 · 73 coment. · 2026-10-08: [Built an age of sail strategy game with Claude Opus 5.5. Is it slop?](https://www.reddit.com/r/aigamedev/comments/1x0k32m/built_an_age_of_sail_strategy_game_with_claude)
- devforum.roblox.com · ♥114 · 24 resp. · 5.1k views · 2026-09-23: [Introducing New Texture Generation Tools, Segment Any Mesh, and Image Previews](https://devforum.roblox.com/t/4890084)
- devforum.roblox.com · ♥28 · 11 resp. · 2k views · 2026-09-25: [Roblox-brain | A Roblox skill library for AI coding agents](https://devforum.roblox.com/t/4894055)
- devforum.roblox.com · ♥5 · 7 resp. · 2026-09-14: [Unannounced, or at least not easily discoverable capabilities feature flag bricks Astra](https://devforum.roblox.com/t/unannounced-or-at-least-not-easily-discoverable-capabilities-feature-flag-bricks-astra/4872775)
- YouTube (3D-Agent) · 2.8k views · 2026-09-27: [Claude in Blender: Can 3D-Agent Build the Roblox Backrooms?](https://www.youtube.com/watch?v=3nsODzZlPJk)
- devforum.roblox.com · ♥4 · 4 resp. · 2026-09-26: [Roblox Studio MCP : works up to Claude Code 2.1.280, broken from 2.1.281+](https://devforum.roblox.com/t/roblox-studio-mcp-works-up-to-claude-code-21280-broken-from-21281/4896239)

## Conclusão

Para o seu caso, a ordem prática é: manter o Claude Code na 2.1.277 (ou até a 2.1.280) até a issue #97319 ser resolvida; ligar o MCP embutido do Studio; testar generate_procedural_model com imagem de referência, seguido de /segment_mesh, textura gerada e screen_capture para conferir, porque é o caminho mais curto e oficial; e reservar o fluxo Blender com orçamento de triângulos para os modelos principais, onde o controle importa mais. Para conhecimento de Roblox, a roblox-brain e a roblox-dev-skill são as candidatas mais cuidadosas, mas leia o código antes de instalar e ignore os repositórios marcados como suspeitos. O que falta saber é quanto o generate_mesh nativo perde, ou ganha, para o Blender com Hi3DGen em qualidade e número de triângulos; isso pede um teste seu, com o mesmo prompt nos dois caminhos.

## Guia de afirmações

**Pode afirmar**
- O Roblox Studio tem um servidor MCP oficial embutido; skills da comunidade como a roblox-dev-skill são só Markdown que ensinam o agente a dirigir esse servidor, sem ferramentas próprias.
- Roqer (criado 2026-09-25, 123 estrelas, 3 releases em uma semana) é um agente para o Studio que usa a assinatura do Claude Code; modela no Blender o que Parts não fazem, confere cada modelo com render de prévia e sobe para o jogo via Open Cloud.
- O servidor MCP do Roblox Studio vem embutido no Studio, roda local via stdio e é ligado em Assistant > Manage MCP Servers > Enable Studio as MCP server, com quick connect para o Claude Code (página oficial atualizada em 2026-10-08).
- O MCP oficial já tem ferramentas de criação de assets: generate_mesh (malha 3D texturizada a partir de texto), generate_procedural_model (modelo de peças primitivas, aceita imagem de referência e esquema de peças), generate_material, search_asset e insert_asset.
- A documentação oficial avisa que clientes MCP leem e alteram o conteúdo dos places abertos; só conecte clientes de confiança.
- Em 2026-09-23 o Roblox lançou no Studio texturas geradas melhores (inclusive em modelos existentes, pelo comando /generate_texture), /segment_mesh para dividir malhas importadas em até 5 partes nomeadas, e prévia em imagem antes de gerar malhas e modelos procedurais.
- Fluxo do SyphoDev (vídeo de 2026-10-04, 91 mil views): Claude Code com Opus 5.5 e skills, ligado ao servidor MCP embutido do Studio; Flux no Cloudflare Workers AI para imagens e ícones; Hi3DGen numa GPU grátis do Kaggle para modelos 3D; Blender para ficar abaixo do limite de triângulos do Roblox; upload pela API Open Cloud.
- A partir do Claude Code 2.1.281 o MCP oficial do Roblox Studio conecta mas fica com 0 ferramentas: o cliente rejeita os campos novos ttlMs e cacheScope do tools/list (protocolo 2026-07-28). Funcionava até a 2.1.280; a issue #97319 no repositório do Claude Code segue aberta.
- Pacotes de skills novos surgiram na janela: SyphoDev roblox-ai-skills (criado 2026-10-07), com skill roblox-3d-model (texto ou imagem para MeshPart via Blender) e um orquestrador que roda os estágios em subagentes; EL4CTEO/roblox-skills (2026-09-28); figma-to-roblox-ui (2026-09-24).

**Afirme com a correção**
- Nos fluxos da comunidade que mais aparecem, o Claude dirige o Blender (gera ou edita a malha, reduz polígonos, confere com render de prévia) e importa como MeshPart; em paralelo, o MCP oficial já gera malhas e modelos procedurais direto no Studio. (Generalizei demais: a doc oficial mostra geração de malhas e modelos procedurais direto no Studio.)

## Lacunas

- Q1: Catálogo SkillsMP não consultado: fonte desligada (sem SKILLSMP_API_KEY).
- Q2: X desligado: sem posts de profissionais no X.
- Q2: Transcrições do YouTube indisponíveis: técnicas detalhadas nos vídeos só pela descrição.
- Q3: Não achei documentação da Anthropic específica para Roblox; o suporte oficial vem pelo lado do Roblox (MCP e Assistant).

## Metodologia

- Sub-perguntas: Q1 Quais servidores MCP e skills para Roblox Studio + Claude surgiram ou foram atualizados nos últimos 30 dias, e quais estão realmente ativos? [tools, code]; Q2 Que técnicas e fluxos os devs estão relatando para gerar modelos 3D e builds melhores com o Claude (prompts, pipelines, Blender, geração de mesh, Studio MCP)? [community]; Q3 O que o Roblox e a Anthropic documentam oficialmente sobre MCP no Roblox Studio e sobre o Claude para criação de assets? [official]; Q4 Quais problemas, limitações e críticas aparecem (bugs de conexão, versões do Claude Code, qualidade dos modelos gerados, segurança)? [community, code]
- Fontes registradas: 71 (mcp_registry 3, github 17, youtube 17, reddit 8, page 6, forums 14, github_issues 6); lidas na íntegra: 15
- Achados: 26; verificados: 10
- Janela: últimos 30 dias

## Fontes

1. [Connect to the Roblox Studio MCP server (documentação oficial, Markdown)](https://create.roblox.com/docs/en-us/studio/mcp.md) (create.roblox.com) `Sgrgn7w`
2. [Roblox-brain | A Roblox skill library for AI coding agents](https://devforum.roblox.com/t/4894055) (Bloxec · devforum.roblox.com · 2026-09-25 · ♥28 · 11 resp. · 2k views) `S2y8m0v`
3. [How to Make a Roblox Game With AI (Claude Opus 5.5 Full Tutorial)](https://www.youtube.com/watch?v=afuKhenJldY) (SyphoDev · youtube.com · 2026-10-05 · 91.5k views) `Sbh7rqb`
4. [Introducing New Texture Generation Tools, Segment Any Mesh, and Image Previews](https://devforum.roblox.com/t/4890084) (LuckyRainGG · devforum.roblox.com · 2026-09-23 · ♥114 · 24 resp. · 5.1k views) `Sq1v5wo`
5. [S4US/Roqer](https://github.com/S4US/Roqer) (S4US · github.com · 2026-10-10 · ★123) `Sr8hnkq`
6. [Built an age of sail strategy game with Claude Opus 5.5. Is it slop?](https://www.reddit.com/r/aigamedev/comments/1x0k32m/built_an_age_of_sail_strategy_game_with_claude) (AdSad7594 · reddit.com · 2026-10-08 · ▲76 · 73 coment.) `Sv55gj4`
7. [Roblox Studio MCP : works up to Claude Code 2.1.280, broken from 2.1.281+](https://devforum.roblox.com/t/roblox-studio-mcp-works-up-to-claude-code-21280-broken-from-21281/4896239) (M_xOL1 · devforum.roblox.com · 2026-09-26 · ♥4 · 4 resp.) `Se8yo1e`
8. [BUG MCP client rejects valid tools/list response due to strict validation of ttlMs/cacheScope fields (Roblox Studio MCP server)](https://github.com/anthropics/claude-code/issues/97319) (rsc1982cel9-droid · github.com · 2026-09-26 · ♥6 · 11 coment.) `Sy6et31`
9. [Studio MCP Server Updates and External LLM Support for Assistant](https://devforum.roblox.com/t/4415631) (avienn_a · devforum.roblox.com · 2026-02-21 · ♥1.1k · 209 resp. · 51.5k views) `Stvnu2d`
10. [Roblox Studio、MCPサーバーを大幅更新　AIエージェント導入・ClaudeなどLLM連携対応](https://www.moguravr.com/roblox-studio-mcp-server-agentic-update) (Mogura VR News編集部 · moguravr.com · 2026-02-24) `Snpfbpm`
11. [SyphoDev-yt/roblox-ai-skills](https://github.com/SyphoDev-yt/roblox-ai-skills) (SyphoDev-yt · github.com · 2026-10-07 · ★9) `S8qozid`
12. [Claude Opus 5.5 + Roblox Studio is Insane (Higgsfield API)](https://www.youtube.com/watch?v=yzBTQRfAdOk) (Cole · youtube.com · 2026-09-30 · 69.1k views) `S4n7buo`
13. [MSayib/roblox-dev-skill](https://github.com/MSayib/roblox-dev-skill) (MSayib · github.com · 2026-10-07 · ★35) `Sqaiu6u`
14. [EL4CTEO/roblox-skills](https://github.com/EL4CTEO/roblox-skills) (github.com · ★17) `S1dnltu`
15. [xtrair/figma-to-roblox-ui](https://github.com/xtrair/figma-to-roblox-ui) (github.com · ★2) `Srgn84s`
16. [Chrrxs/robloxstudio-mcp](https://github.com/Chrrxs/robloxstudio-mcp) (github.com · ★290) `Sx8adqa`
17. [AallamR/RobloxForge-Intelligence](https://github.com/AallamR/RobloxForge-Intelligence) (github.com · ★70) `S6kesbu`
18. [adamenrem-jpg/Roblox-Live-Bridge-MCP](https://github.com/adamenrem-jpg/Roblox-Live-Bridge-MCP) (github.com · ★70) `Sr0nh3m`
19. [Codex MCP Server bug](https://devforum.roblox.com/t/codex-mcp-server-bug/4898883) (Sylmat · devforum.roblox.com · 2026-09-27 · ♥2 · 4 resp.) `S22tfpj`
20. [Capabilities Error on requiring some modules with mcp](https://devforum.roblox.com/t/capabilities-error-on-requiring-some-modules-with-mcp/4908470) (lrogerorrit · devforum.roblox.com · 2026-10-02 · ♥10 · 1 resp.) `Sltteoo`
21. [MCP frequently dropping connections and not listing all, or any, open instances](https://devforum.roblox.com/t/mcp-frequently-dropping-connections-and-not-listing-all-or-any-open-instances/4737086) (iidffkdud · devforum.roblox.com · 2026-09-16 · ♥0 · 6 resp.) `Sz21c27`
22. [Unannounced, or at least not easily discoverable capabilities feature flag bricks Astra](https://devforum.roblox.com/t/unannounced-or-at-least-not-easily-discoverable-capabilities-feature-flag-bricks-astra/4872775) (DistortedByTime · devforum.roblox.com · 2026-09-14 · ♥5 · 7 resp.) `Sb7abuv`
23. [I asked 14 AI models to rebuild this photo in Blender. This is what each one made](https://www.reddit.com/r/ChatGPT/comments/1wvqlwh/i_asked_14_ai_models_to_rebuild_this_photo_in) (smith2008 · reddit.com · 2026-10-02) `Sbuvvct`

_Outras 48 fontes foram coletadas e não citadas; estão em sources.jsonl._
