# Trawl

**Pesquisa profunda para qualquer IDE com IA, com fontes que o servidor confere.** O Trawl é um servidor MCP: ligue no Claude Code, Cursor, VS Code (Copilot), Windsurf, Codex, Gemini CLI ou Claude Desktop, e a sua IA ganha um roteiro de pesquisa que busca na web e onde as pessoas conversam de verdade (Reddit, X, YouTube, Hacker News, GitHub), ordena tudo numa lista só, lê as melhores fontes e recusa citação que ele não consegue conferir.

[Read in English](README.md)

## O que faz

- **Coleta em um passo (`trawl_collect`):** várias variações da consulta em várias fontes, um ranking único, leitura das melhores fontes e só os trechos relevantes de volta. Uma pesquisa que levava umas 35 chamadas cabe em 5 a 10.
- **Muitas fontes em paralelo:** web (SearXNG local grátis), Reddit (posts e comentários), Hacker News, X, YouTube (com transcrição), fóruns Discourse, GitHub (repositórios, issues, Discussions e código via grep.app, GitHub e Sourcegraph), arXiv, OpenAlex, Stack Overflow, Wikipedia, MCP Registry e SkillsMP, com votos, estrelas, views, citações e datas.
- **Ranking único entre fontes:** relevância, confiança da fonte (oficial, governo, acadêmico, documentação, código, imprensa, site, fórum, blog, post solto), engajamento comparado dentro de cada plataforma e data. Resultado fora do tema ("uv" do Python contra luz UV) é descartado.
- **Citação conferida pelo servidor:** achado-chave e veredito "confirmado" levam a frase exata da fonte; o servidor procura a frase, palavra por palavra, no texto que ele mesmo leu e recusa se não bater, devolvendo a frase mais parecida que existe de verdade.
- **Voz da comunidade, não só páginas:** as discussões mais comentadas são lidas sozinhas; quando a maioria dos resultados vem de um subreddit, o Trawl busca dentro dele também.
- **Fontes oficiais que só abrem com JavaScript:** lidas com o Chrome ou Edge já instalado, sem interface e com perfil vazio. Nunca contra bloqueio anti-robô. Anúncios de jogos na Steam contam como fonte oficial.
- **Janela de dias de verdade:** `since_days` em toda fonte com data, com conferência final que descarta o que ficou fora.
- **Filtro de lixo:** repositório com estrela comprada vem marcado como ⚠ SUSPEITO e vai para o fim; post repetido em vários subreddits vira um só.
- **Memória e radar:** `trawl_recall` mostra o que pesquisas anteriores acharam; `trawl_radar` repete uma busca de tempos em tempos e mostra só o que é novo.
- **Leitura funda, com controle:** o servidor guarda o texto inteiro de tudo que lê, e um registro de leitura anota quanto de cada texto chegou de fato à sua IA. Fonte longa que ela só viu em trechos curtos (transcrição de vídeo, tutorial, documentação) vai para uma fase de leitura funda: lida inteira, com os achados registrados e a citação conferida. O relatório diz quanto foi lido a fundo, não só "lido".
- **Um maestro de pesquisa:** sessões salvas em disco passam por plano, coleta, leitura funda, cruzamento, verificação e relatório. `trawl_next` sempre diz o próximo passo, e o relatório recusa citação que não foi registrada.

A IA da IDE pensa e escreve; o servidor busca, guarda e cobra o método. Ele não chama LLM nenhum por conta própria (exceto o Grok, se você ligar a busca no X pela xAI).

## Instalar

Requer Node 22.12+ (testado no 24).

```bash
git clone https://github.com/FFloriani/trawl.git
cd trawl
npm install
npm run build
node dist/index.js doctor
```

O `doctor` mostra o que já funciona e como ligar o resto. As chaves ficam em `~/.trawl/.env` (modelo em [.env.example](.env.example)), então a configuração da IDE nunca carrega segredo.

### Busca web grátis (SearXNG local)

Com o Docker aberto:

```bash
npm run searxng
```

Sobe um SearXNG em `http://127.0.0.1:8888` (só a sua máquina acessa), testa uma busca e grava `SEARXNG_URL` no `~/.trawl/.env`. Sem chave e sem cota. O container volta sozinho quando o Docker abre. Para parar: `npm run searxng:stop`.

Se o próprio Docker estiver fechado (depois de reiniciar o PC, por exemplo), o SearXNG local fica fora do ar e a sua IA usa a busca web dela; basta abrir o Docker Desktop que o container volta. O Trawl também pode abrir o Docker Desktop e subir o container por você, mas só se você pedir (`TRAWL_SEARXNG_AUTOSTART=1`) e só no momento em que um agente usa a busca web: abrir uma sessão não inicia nada, e o Docker continua fechado enquanto nenhuma pesquisa roda. A partida a frio leva de 1 a 3 minutos, então a primeira busca cai na busca web da própria IA. O Trawl não fecha o Docker depois.

| Sem nenhuma chave | Com chave |
|---|---|
| Web pelo SearXNG local, Reddit (busca do próprio site com votos atuais, threads com comentários, busca em comentários do Reddit inteiro pelo PullPush; reserva em RSS e Arctic Shift), Hacker News, fóruns Discourse, YouTube (com transcrição), GitHub (usa o login do `gh`), MCP Registry, arXiv, OpenAlex, Stack Overflow, Wikipedia, leitura de posts do X | Web por Brave, Tavily ou Exa; Reddit OAuth (só com app já aprovado pelo Reddit); busca no X (twitterapi.io a ~US$0,15 por 1.000 posts, xAI/Grok ou API oficial); SkillsMP |

Sem SearXNG nem chave de busca web, a IA usa a busca nativa dela e registra os resultados com `trawl_add_sources`.

## Conectar na sua IDE

Troque o caminho pelo da sua máquina. No Windows, use barras normais (`C:/caminho/para/trawl/dist/index.js`).

**Claude Code**
```bash
claude mcp add trawl --scope user -- node "/caminho/para/trawl/dist/index.js"
```
Opcional: copie `integrations/claude-code/skills/trawl` para `~/.claude/skills/` para ganhar o `/trawl`, que dispara a coleta em subagentes paralelos.

**Cursor** (`~/.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`), **Claude Desktop** (`claude_desktop_config.json`), **Gemini CLI** (`~/.gemini/settings.json`):
```json
{
  "mcpServers": {
    "trawl": {
      "command": "node",
      "args": ["/caminho/para/trawl/dist/index.js"]
    }
  }
}
```

**VS Code / Copilot** (`.vscode/mcp.json` ou o `mcp.json` do usuário):
```json
{
  "servers": {
    "trawl": {
      "type": "stdio",
      "command": "node",
      "args": ["/caminho/para/trawl/dist/index.js"]
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.trawl]
command = "node"
args = ["/caminho/para/trawl/dist/index.js"]
```

## Usar

- **Pesquisa completa:** o prompt `pesquisa` (no Claude Code: `/mcp__trawl__pesquisa`, ou `/trawl` com a skill), ou peça "pesquise a fundo X com o Trawl". A IA chama `trawl_start` e segue o `trawl_next`.
- **Rápida:** prompt `pesquisa_rapida`.
- **Só a comunidade:** prompt `comunidade` (Reddit, HN, X, YouTube e issues do GitHub dos últimos dias).
- **Avulso:** `trawl_collect` (ou `trawl_search` e `trawl_read`).
- **O que já se sabe:** `trawl_recall` com o tema.
- **Acompanhar um tema:** `trawl_radar` com `action=create`, um nome e as consultas. Ele roda na hora (linha de base) e depois mostra só o que é novo.

No Reddit, `subreddit:Nome termos` busca dentro do subreddit, com votos. Fóruns Discourse não têm padrão: `forum:host termos` (ex.: `forum:discuss.python.org`) ou `forums` no `trawl_plan` escolhem os do assunto; `TRAWL_FORUMS` fixa alguns para todas as pesquisas.

### Radar rodando sozinho

O servidor MCP só roda quando a IDE chama, então o agendamento fica com o sistema. No Windows, um radar diário às 8h:

```bash
schtasks /Create /SC DAILY /ST 08:00 /TN "Trawl Radar" /TR "node \"C:/caminho/para/trawl/dist/index.js\" radar run --due"
```

No Linux e no macOS, o mesmo comando (`node /caminho/para/trawl/dist/index.js radar run --due`) vai no cron. Cada execução grava um resumo em `~/.trawl/radar/<nome>/runs/`.

### Ferramentas

| Ferramenta | Faz |
|---|---|
| `trawl_doctor` | Mostra as fontes ligadas e como ligar o resto |
| `trawl_collect` | Coleta num passo: variações × fontes, ranking único, leitura das melhores e trechos relevantes |
| `trawl_search` | Busca em várias fontes ao mesmo tempo, em ranking único |
| `trawl_read` | Lê uma fonte inteira em Markdown, em janelas (na sessão, guarda o texto para conferir citações e registra quanto você leu) |
| `trawl_ask_repo` | Pergunta ao DeepWiki como um repositório funciona (resposta de IA, conferir no código) |
| `trawl_start` | Abre uma sessão de pesquisa (`deep_read`: quantas fontes longas ler inteiras; 0 pula a fase) |
| `trawl_plan` | Registra sub-perguntas, camadas de fonte, domínios oficiais e fóruns do assunto |
| `trawl_add_sources` | Registra fontes achadas fora do servidor |
| `trawl_add_findings` | Registra achados (com fonte; o achado-chave com a frase exata, conferida) e lacunas |
| `trawl_crosscheck` | Cruza achados: conflitos, consensos, pontos cegos |
| `trawl_verify` | Registra o veredito de cada achado-chave ("confirmado" exige a frase da fonte primária) |
| `trawl_report` | Gera o relatório (Markdown + HTML) e valida as citações |
| `trawl_next` | Fase atual e próximo passo (`read_more` lista mais fontes longas para estudar, mesmo depois do relatório) |
| `trawl_sessions` | Lista pesquisas salvas |
| `trawl_recall` | Busca nos achados de todas as pesquisas anteriores |
| `trawl_radar` | Cria, roda, lista e apaga radares de novidades |

O método completo está em [docs/METHOD.md](docs/METHOD.md) e também é servido como recurso `trawl://metodo`.

## Onde ficam as coisas

- `~/.trawl/.env`: chaves
- `~/.trawl/cache/`: cache das buscas (economiza cota)
- `~/.trawl/research/<data>-<tema>--<id>/`: cada pesquisa, com `session.json`, `sources.jsonl`, `claims.jsonl`, `gaps.jsonl`, `verifications.jsonl`, `reading.jsonl` (quanto de cada texto chegou ao modelo), `texts/` (texto das fontes lidas), `report.md` e `report.html`
- `~/.trawl/radar/<nome>/`: definição do radar, URLs já vistas e um resumo por execução

Os ajustes também valem como variáveis de ambiente (`TRAWL_HOME`, `TRAWL_FORUMS`, `TRAWL_BROWSER`…); veja o [.env.example](.env.example).

## Linha de comando

```bash
node dist/index.js search "deep research agent" --sources reddit,hn,github --days 30
node dist/index.js read https://news.ycombinator.com/item?id=49303046
node dist/index.js radar run --due
```

Exemplo real: [docs/exemplos](docs/exemplos) tem um relatório feito de ponta a ponta pelo servidor (71 fontes, 26 achados, 10 verificados).

## Uso responsável

- O Trawl lê páginas e APIs públicas, em ritmo educado (intervalo mínimo por site, cache, respeito ao `Retry-After`).
- Ele nunca resolve CAPTCHA, nunca forja token anti-robô e nunca usa o navegador sem interface contra uma verificação de robô. Fonte que bloqueia vira lacuna no relatório.
- O `REDDIT_COOKIE` opcional usa a sua própria sessão logada do Reddit para trazer resultados mais completos. Isso vai contra os termos do Reddit e pode pôr a conta em risco; fica desligado se você não definir.
- Respeite os termos dos sites e APIs que você ligar.

## Desenvolvimento

```bash
npm run typecheck
npm test            # testes unitários, sem rede
npm run test:live   # cliente MCP real contra o servidor compilado, com APIs reais (rode o build antes)
npm run dev         # roda direto do TypeScript (Node 24)
node scripts/call.mjs trawl_doctor '{}'   # chama qualquer ferramenta pelo MCP real, como uma IDE faria
```

Stack: TypeScript no Node, `@modelcontextprotocol/sdk` fixado em 1.32.1 (protocolo 2025-11-25), Readability + Turndown para páginas, linkedom, fast-xml-parser e marked.

## Créditos

O Trawl se apoia em trabalho e ideias de outras pessoas:

- [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill): a ideia de pesquisar "o que as pessoas disseram nos últimos N dias" e o jeito de buscar no Reddit pelos fragmentos do próprio site.
- [jdepoix/youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api): o método para pegar a transcrição dos vídeos do YouTube.
- [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift) e [PullPush](https://pullpush.io): arquivos do Reddit e busca em comentários.
- [FxTwitter](https://github.com/FxEmbed/FxEmbed): leitura grátis de posts do X.
- [SearXNG](https://github.com/searxng/searxng), [DeepWiki](https://deepwiki.com), [grep.app](https://grep.app), [Sourcegraph](https://sourcegraph.com), [HN Algolia](https://hn.algolia.com/api), [OpenAlex](https://openalex.org), [arXiv](https://arxiv.org), [Stack Exchange](https://api.stackexchange.com), [Wikipedia](https://www.wikipedia.org) e o [MCP Registry](https://registry.modelcontextprotocol.io).

## Licença

[MIT](LICENSE)
