import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (
  !OPENAI_API_KEY ||
  !SLACK_SIGNING_SECRET ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error("Variáveis de ambiente obrigatórias não definidas.");
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifySlack(req: Request, rawBody: string) {
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");

  if (!timestamp || !signature) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const enc = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  const computed = `v0=${hex(sig)}`;

  return computed === signature;
}

function sanitizeSlackText(text: string) {
  return text
    .replace(/[<>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildContext(docs: any[]) {
  return docs
    .slice(0, 4)
    .map((d: any, i: number) => {
      const content = String(d?.content ?? "")
        .slice(0, 1000)
        .trim();
      const title = d?.title ? String(d.title) : `Documento ${i + 1}`;
      const category = d?.category ? String(d.category) : "sem_categoria";

      return `[Fonte ${i + 1}]
Título: ${title}
Categoria: ${category}
Conteúdo:
${content}`;
    })
    .join("\n---\n");
}

function normalizeText(text: string) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function looksRelevant(question: string, docs: any[]) {
  const q = normalizeText(question);
  const qWords = q
    .split(/[^a-z0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);

  if (qWords.length === 0) return docs.length > 0;

  const joinedDocs = normalizeText(
    docs
      .map((d: any) =>
        `${d?.title ?? ""} ${d?.category ?? ""} ${d?.content ?? ""}`.slice(
          0,
          1500,
        ),
      )
      .join(" "),
  );

  let hits = 0;
  for (const word of qWords) {
    if (joinedDocs.includes(word)) hits++;
  }

  return hits >= 1;
}

async function sendSlackResponse(
  responseUrl: string,
  text: string,
  responseType: "ephemeral" | "in_channel" = "in_channel",
) {
  if (!responseUrl) return;

  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: responseType,
      text,
    }),
  });
}

serve(async (req) => {
  try {
    const rawBody = await req.text();

    const ok = await verifySlack(req, rawBody);
    if (!ok) {
      return new Response("Invalid signature", { status: 401 });
    }

    const params = new URLSearchParams(rawBody);
    const question = sanitizeSlackText(params.get("text") || "");
    const responseUrl = params.get("response_url") || "";

    if (!question) {
      return new Response(
        JSON.stringify({
          response_type: "ephemeral",
          text: "Manda uma pergunta após o /ask 🙂",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const immediate = new Response(
      JSON.stringify({
        response_type: "ephemeral",
        text: `Buscando na base...\n> *${question}*`,
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );

    (async () => {
      const t0 = Date.now();

      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        // ============================================================
        // 0) EXPANSÃO DA QUERY
        // Reescreve perguntas curtas/informais antes de gerar o embedding.
        // Exemplo: "Taxa Nox?" → "Quais são as taxas cobradas pela NoxPay?"
        // ============================================================
        let expandedQuestion = question;

        try {
          const expandRes = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "gpt-4o-mini",
                temperature: 0,
                messages: [
                  {
                    role: "system",
                    content: `Você é um assistente que reescreve perguntas curtas ou informais em perguntas completas e claras sobre a NoxPay, mantendo o mesmo significado. Responda APENAS com a pergunta reescrita, sem explicações adicionais.`,
                  },
                  { role: "user", content: question },
                ],
              }),
            },
          );

          if (expandRes.ok) {
            const expandJson = await expandRes.json();
            const rewritten =
              expandJson?.choices?.[0]?.message?.content?.trim();
            if (rewritten) {
              expandedQuestion = rewritten;
              console.log(`Query original: "${question}"`);
              console.log(`Query expandida: "${expandedQuestion}"`);
            }
          }
        } catch (expandErr) {
          // Se falhar, segue com a pergunta original sem travar o fluxo
          console.warn("Expansão de query falhou, usando original:", expandErr);
        }
        // ============================================================

        // 1) Embedding — agora usa a query expandida
        const embRes = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: expandedQuestion, // ← era "question", agora é "expandedQuestion"
          }),
        });

        if (!embRes.ok) {
          const errorText = await embRes.text();
          console.error("Erro embedding:", errorText);
          await sendSlackResponse(
            responseUrl,
            "Não consegui processar a pergunta agora.",
            "ephemeral",
          );
          return;
        }

        const embJson = await embRes.json();
        const embedding = embJson?.data?.[0]?.embedding;

        if (!embedding) {
          console.error("Embedding não retornado pela OpenAI.");
          await sendSlackResponse(
            responseUrl,
            "Não consegui processar a pergunta corretamente.",
            "ephemeral",
          );
          return;
        }

        // 2) Vector search
        const { data: docs, error } = await supabase.rpc("match_documents", {
          query_embedding: embedding,
          match_count: 4,
        });

        if (error) {
          console.error("Erro Supabase RPC:", error);
          await sendSlackResponse(
            responseUrl,
            "Não consegui consultar a base de conhecimento agora.",
            "ephemeral",
          );
          return;
        }

        // Fast fail: sem docs
        if (!docs || docs.length === 0) {
          await sendSlackResponse(
            responseUrl,
            "Não encontrei essa informação na base disponível.",
            "in_channel",
          );
          return;
        }

        // Fast fail: docs retornaram, mas parecem irrelevantes
        if (!looksRelevant(question, docs)) {
          await sendSlackResponse(
            responseUrl,
            "Não encontrei essa informação na base disponível.",
            "in_channel",
          );
          return;
        }

        const context = buildContext(docs);

        // 3) Prompt
        const systemPrompt = `
Você é um agente interno de suporte da NoxPay.

Responda exclusivamente com base no CONTEXTO fornecido.

Regras:
- Não invente informações.
- Não use conhecimento externo.
- Se a resposta não estiver claramente presente no contexto, diga exatamente: "Não encontrei essa informação na base disponível."
- Responda sempre em português.
- Dê respostas claras, úteis e objetivas.
- A resposta pode ser explicativa, mas não precisa ser longa.
- Quando fizer sentido, explique rapidamente:
  - o que é
  - o que significa
  - o que fazer
- Se houver procedimento no contexto, apresente em passos curtos.
- Se houver SLA, prazo, limite ou observação importante, inclua isso.
- Se a pergunta envolver erro, status ou falha operacional, explique o significado e a ação esperada.
- Não copie blocos grandes literalmente; reescreva de forma natural.
- Priorize respostas práticas para o time.

Formato preferido:
- Comece com a resposta objetiva.
- Depois complemente com os detalhes essenciais.
- Se aplicável, inclua procedimento e SLA.

CONTEXTO:
${context}
`.trim();

        // 4) GPT — recebe a pergunta ORIGINAL do usuário (não a expandida)
        const compRes = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              temperature: 0.1,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: question }, // ← pergunta original mantida aqui
              ],
            }),
          },
        );

        if (!compRes.ok) {
          const errorText = await compRes.text();
          console.error("Erro GPT:", errorText);
          await sendSlackResponse(
            responseUrl,
            "Não consegui gerar a resposta agora.",
            "ephemeral",
          );
          return;
        }

        const compJson = await compRes.json();
        const answer =
          compJson?.choices?.[0]?.message?.content?.trim() ||
          "Não consegui gerar resposta agora.";

        const slackAnswer = answer
          .replace(/\*\*(.*?)\*\*/g, "*$1*")
          .replace(/__(.*?)__/g, "_$1_");

        const hasContext =
          !/não encontrei essa informação na base disponível/i.test(answer);

        const { error: insertError } = await supabase
          .from("user_questions")
          .insert({
            question,
            answer,
            has_context: hasContext,
          });

        if (insertError) {
          console.error("Erro salvando pergunta:", insertError);
        }

        console.log("Tempo total ms:", Date.now() - t0);

        await sendSlackResponse(responseUrl, slackAnswer, "in_channel");
      } catch (e) {
        console.error("Erro no processamento:", e);
        await sendSlackResponse(
          responseUrl,
          "Erro ao processar a pergunta.",
          "ephemeral",
        );
      }
    })();

    return immediate;
  } catch (err) {
    console.error("Erro geral:", err);

    return new Response(
      JSON.stringify({
        response_type: "ephemeral",
        text: "Erro interno.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});
