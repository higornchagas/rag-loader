import "dotenv/config";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import crypto from "node:crypto";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

console.log("🚀 Iniciando ingest...");

const openai = new OpenAI({ apiKey: mustEnv("OPENAI_KEY") });
const supabase = createClient(
  mustEnv("SUPABASE_URL"),
  mustEnv("SUPABASE_SERVICE_KEY"),
);

const hash = (text) => crypto.createHash("md5").update(text).digest("hex");

const normalize = (text) =>
  String(text ?? "")
    .replace(/^Q:\s*/i, "")
    .replace(/\nA:\s*/i, "\n")
    .trim();

const chunkText = (text, size = 1200) => {
  const chunks = [];
  for (let i = 0; i < text.length; i += size)
    chunks.push(text.slice(i, i + size));
  return chunks;
};

async function run() {
  const start = Date.now();

  console.log("\n📂 Lendo chunks.json...");
  const items = JSON.parse(fs.readFileSync("./chunks.json", "utf-8"));

  if (!Array.isArray(items))
    throw new Error("chunks.json precisa ser um array de objetos");

  console.log(`📊 ${items.length} registros carregados`);

  const candidates = [];
  const seen = new Map();

  console.log("\n🧹 Deduplicando source_id...");

  for (const item of items) {
    const sid = String(item?.source_id ?? "").trim();
    if (!sid) continue;
    seen.set(sid, item);
  }

  console.log(`📊 ${seen.size} documentos únicos`);

  console.log("\n✂️ Gerando chunks finais...");

  for (const item of seen.values()) {
    const content = normalize(item.content);
    if (!content) continue;

    const baseSourceId =
      String(item.source_id).trim() || `auto_${hash(content).slice(0, 12)}`;

    const parts = content.length > 1200 ? chunkText(content) : [content];

    for (let p = 0; p < parts.length; p++) {
      const chunk = parts[p].trim();

      if (!chunk) continue;

      candidates.push({
        source_id: baseSourceId,
        chunk_index: p,
        content: chunk,
        content_hash: hash(chunk),
      });
    }
  }

  if (!candidates.length) {
    console.log("⚠️ Nenhum candidato gerado.");
    return;
  }

  console.log(`📦 ${candidates.length} chunks candidatos`);

  console.log("\n🔎 Consultando Supabase para detectar mudanças...");

  const sourceIds = [...new Set(candidates.map((c) => c.source_id))];

  const { data: existing, error: existingErr } = await supabase
    .from("documents")
    .select("source_id, chunk_index, content_hash")
    .in("source_id", sourceIds);

  if (existingErr) throw existingErr;

  console.log(`📊 ${existing?.length ?? 0} chunks já existentes no banco`);

  const existingMap = new Map(
    (existing ?? []).map((r) => [
      `${r.source_id}::${r.chunk_index}`,
      r.content_hash,
    ]),
  );

  let skipped = 0;
  const rowsToUpsert = [];

  const BATCH = 5;

  console.log("\n🧠 Gerando embeddings...");

  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);

    const batch = slice.filter(
      (c) =>
        existingMap.get(`${c.source_id}::${c.chunk_index}`) !== c.content_hash,
    );

    skipped += slice.length - batch.length;

    console.log(
      `⚙️ batch ${i / BATCH + 1} → ${batch.length} embeddings (${slice.length - batch.length} pulados)`,
    );

    await Promise.all(
      batch.map(async (c) => {
        try {
          const emb = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: c.content,
          });

          rowsToUpsert.push({
            ...c,
            embedding: emb.data[0].embedding,
          });

          console.log(`✔ embed ok → ${c.source_id} #${c.chunk_index}`);
        } catch (err) {
          console.error(
            `❌ erro no embedding → ${c.source_id} #${c.chunk_index}`,
            err,
          );
        }
      }),
    );
  }

  console.log(`\n⏭️ ${skipped} chunks ignorados (sem mudanças)`);

  if (!rowsToUpsert.length) {
    console.log("✅ Nada novo pra atualizar.");
    return;
  }

  console.log(`\n💾 Salvando ${rowsToUpsert.length} embeddings no Supabase...`);

  const { error } = await supabase
    .from("documents")
    .upsert(rowsToUpsert, { onConflict: "source_id,chunk_index" });

  if (error) throw error;

  const duration = ((Date.now() - start) / 1000).toFixed(2);

  console.log(
    `\n✅ ingest finalizado\n📊 upserts: ${rowsToUpsert.length}\n⏱ tempo: ${duration}s`,
  );
}

run().catch((e) => {
  console.error("🔥 erro geral:", e);
  process.exit(1);
});
