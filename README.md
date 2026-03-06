# 🤖 NoxPay RAG — Slack Bot com IA

Bot de perguntas e respostas no Slack alimentado por um pipeline RAG (Retrieval-Augmented Generation) usando OpenAI + Supabase. O usuário digita `/ask <pergunta>` no Slack e o bot busca a resposta na base de conhecimento da NoxPay.

---

## 📁 Estrutura do Projeto

```
.
├── knowledge/
│   └── noxfaq.txt           # Base de conhecimento em formato Q&A
├── supabase/
│   └── functions/
│       └── rag-nox/
│           └── index.ts     # Edge Function (handler do Slack)
├── chunkGenerator.js        # Converte o .txt em chunks.json
├── ingest.js                # Envia os chunks com embeddings pro Supabase
├── chunks.json              # Gerado automaticamente (não commitar)
├── .env                     # Variáveis de ambiente (não commitar)
└── package.json
```

---

## ⚙️ Como funciona

```
noxfaq.txt → chunkGenerator.js → chunks.json → ingest.js → Supabase
                                                                ↕
                                              Slack /ask → Edge Function → OpenAI → resposta
```

1. O arquivo `noxfaq.txt` é escrito em formato `[id] / pergunta / resposta`
2. O `chunkGenerator.js` transforma o `.txt` em um array de objetos JSON
3. O `ingest.js` gera embeddings via OpenAI e salva no Supabase (com upsert inteligente)
4. A Edge Function recebe o comando `/ask` do Slack, busca os documentos mais relevantes via similaridade vetorial e gera a resposta com GPT

---

## 📝 Formato do noxfaq.txt

```
[nome-do-topico]
Qual é a pergunta aqui?
Aqui vai a resposta, podendo ter
múltiplas linhas, bullets, tabelas etc.

[outro-topico]
Outra pergunta?
Outra resposta.
```

> O `source_id` é gerado automaticamente a partir do texto entre colchetes, normalizado para lowercase com `_`.

---

## 🚀 Setup

### 1. Instale as dependências

```bash
npm install
```

### 2. Configure o `.env`

```env
OPENAI_KEY=sk-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
```

### 3. Configure as variáveis na Edge Function (Supabase Dashboard)

```
OPENAI_API_KEY
SLACK_SIGNING_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

---

## 🛠️ Scripts disponíveis

```bash
npm run chunk      # Gera chunks.json a partir do noxfaq.txt
npm run ingest     # Envia os chunks com embeddings pro Supabase
npm run update     # Roda chunk + ingest em sequência
npm run deploy     # Faz deploy da Edge Function no Supabase
```

---

## 🧠 Detalhes técnicos

| Item | Valor |
|---|---|
| Modelo de embedding | `text-embedding-3-small` (OpenAI) |
| Modelo de resposta | `gpt-4o-mini` |
| Banco vetorial | Supabase (pgvector) |
| Busca | RPC `match_documents` por similaridade coseno |
| Tamanho do chunk | 1200 caracteres |
| Chunks por busca | 12 mais relevantes |
| Runtime da Edge Function | Deno |

### Upsert inteligente

O `ingest.js` evita reprocessar conteúdo que não mudou. Para cada chunk, é gerado um hash MD5 do conteúdo. Na hora do ingest, o hash é comparado com o que já existe no banco — embedding novo só é gerado se o conteúdo mudou.

### Validação do Slack

A Edge Function valida a assinatura HMAC-SHA256 de cada requisição antes de processar, garantindo que o request veio de fato do Slack.

---

## 🗃️ Tabelas no Supabase

### `documents`

| Coluna | Tipo | Descrição |
|---|---|---|
| `source_id` | text | ID do bloco de origem |
| `chunk_index` | int | Posição do chunk no documento |
| `content` | text | Texto do chunk |
| `content_hash` | text | Hash MD5 do conteúdo |
| `embedding` | vector | Vetor gerado pelo OpenAI |

### `user_questions`

| Coluna | Tipo | Descrição |
|---|---|---|
| `question` | text | Pergunta feita pelo usuário |
| `answer` | text | Resposta gerada pelo GPT |

---

## 🔒 .gitignore recomendado

```
.env
chunks.json
node_modules/
```

---

## 💬 Uso no Slack

```
/ask Como funciona o saque na NoxPay?
```

O bot responde de forma efêmera (só você vê) enquanto busca, e depois envia a resposta final no canal.