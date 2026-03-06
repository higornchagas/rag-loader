// Importa o servidor HTTP do Deno e o cliente do Supabase
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

// Pega as chaves do ambiente (variáveis de ambiente)
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET")!;

// Função utilitária: converte um ArrayBuffer em string hexadecimal
function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Função que valida se a requisição veio mesmo do Slack
async function verifySlack(req: Request, rawBody: string) {
  const timestamp = req.headers.get("x-slack-request-timestamp"); // timestamp do Slack
  const signature = req.headers.get("x-slack-signature"); // assinatura do Slack
  if (!timestamp || !signature) return false;

  const base = `v0:${timestamp}:${rawBody}`; // string que será assinada
  const enc = new TextEncoder();

  // Cria a chave HMAC com o segredo do Slack
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // Calcula a assinatura da requisição
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  const computed = `v0=${hex(sig)}`;

  return computed === signature; // retorna true se a assinatura bate
}

// Aqui criamos o servidor HTTP
serve(async (req) => {
  try {
    const rawBody = await req.text(); // pega o corpo da requisição como string

    // 1) valida Slack
    const ok = await verifySlack(req, rawBody);
    if (!ok) return new Response("Invalid signature", { status: 401 });

    // 2) parse slash command (os parâmetros do /comando do Slack)
    const params = new URLSearchParams(rawBody);
    const question = params.get("text") || ""; // a pergunta do usuário
    const responseUrl = params.get("response_url") || ""; // URL pra responder de volta

    if (!question) {
      // resposta imediata se o usuário não enviou nada
      return new Response(
        JSON.stringify({
          response_type: "ephemeral", // só a pessoa que enviou vê
          text: "Manda uma pergunta após o /ask 🙂",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 3) resposta imediata pra não dar timeout no Slack
    const immediate = new Response(
      JSON.stringify({
        response_type: "ephemeral",
        text: `*Beleza — já tô buscando aqui 👀*\n> Q: *${question}*`,
      }),
      { headers: { "Content-Type": "application/json" } },
    );

    // 4) processa em background: busca no Supabase + OpenAI + envia resposta no Slack
    (async () => {
      try {
        // conecta no Supabase
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        // gera embedding da pergunta usando OpenAI
        const embRes = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "text-embedding-3-small", // modelo de embeddings pequeno e rápido
            input: question,
          }),
        });
        const embJson = await embRes.json();
        const embedding = embJson?.data?.[0]?.embedding;

        // busca documentos parecidos no Supabase (função RPC)
        const { data: docs, error } = await supabase.rpc("match_documents", {
          query_embedding: embedding,
          match_count: 20,
        });
        if (error) throw error;

        // junta o conteúdo dos documentos encontrados
        const context = (docs ?? []).map((d: any) => d.content).join("\n---\n");

        // gera a resposta usando o modelo GPT, fornecendo o contexto
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
              messages: [
                {
                  role: "system",
                  content: `Você é um agente de suporte da NoxPay responsável por responder dúvidas de novos clientes.

                  Responda de forma clara, direta, objetiva e humanizada, utilizando exclusivamente as informações presentes no CONTEXTO fornecido.

                  Regras obrigatórias:

                  1. Use apenas o CONTEXTO. Não utilize conhecimento externo, não faça suposições e não invente informações.
                  2. Não copie trechos do CONTEXTO. Sempre reescreva com suas próprias palavras.
                  3. Não prometa prazos ou condições que não estejam explícitas no CONTEXTO.
                  4. Se a pergunta for vaga ou não tiver informação suficiente, responda exatamente:
                  “Pode me dar mais detalhes da dúvida ou do atendimento que você precisa ajudar?”
                  5. Se a pergunta permitir mais de uma interpretação, peça esclarecimento antes de responder.
                  6. Se houver resposta no CONTEXTO, responda de forma curta, direta e natural, sem rodeios.
                  7. Se não houver resposta no CONTEXTO, informe que não encontrou a informação e direcione para o suporte humano.

                  Responda sempre em português, com tom profissional e cordial, sem emojis.

                  CONTEXTO:
                  ${context}`,
                },
                { role: "user", content: question },
              ],
            }),
          },
        );

        const compJson = await compRes.json();
        const answer =
          compJson?.choices?.[0]?.message?.content ??
          "Não consegui gerar resposta agora.";

        // Converte markdown do GPT para formatação do Slack
        const slackAnswer = answer
          .replace(/\*\*(.*?)\*\*/g, "*$1*") // **negrito** → *negrito*
          .replace(/__(.*?)__/g, "_$1_"); // __itálico__ → _itálico_

        // salva pergunta e resposta no Supabase
        const hasContext =
          !/não encontrei|não encontrou|não está no contexto|pode me dar mais detalhes da dúvida/i.test(
            answer,
          );

        const { error: insertError } = await supabase
          .from("user_questions")
          .insert({ question, answer, has_context: hasContext });

        if (insertError)
          console.error("❌ erro ao salvar pergunta:", insertError);

        // envia a resposta final para o Slack usando o response_url
        if (responseUrl) {
          await fetch(responseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              response_type: "in_channel",
              text: slackAnswer,
            }),
          });
        }
      } catch (_e) {
        // se der erro, avisa só para o usuário que perguntou
        if (responseUrl) {
          await fetch(responseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              response_type: "ephemeral",
              text: "Deu ruim aqui 😬 (falha ao processar)",
            }),
          });
        }
      }
    })();

    // retorna a resposta imediata pra não travar o Slack
    return immediate;
  } catch (_err) {
    return new Response(
      JSON.stringify({ response_type: "ephemeral", text: "Erro interno 😬" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
