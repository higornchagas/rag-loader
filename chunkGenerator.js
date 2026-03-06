const fs = require("fs");

// pega todos os arquivos .txt dentro de knowledge
const files = fs.readdirSync("knowledge").filter((f) => f.endsWith(".txt"));

console.log("Arquivos encontrados:", files);

const isIdLine = (line) => /^\[.+\]$/.test(line.trim());

const sanitizeId = (id) =>
  id
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_:-]/g, "");

const chunks = [];

for (const file of files) {
  console.log("\n📄 Processando arquivo:", file);

  const lines = fs
    .readFileSync(`knowledge/${file}`, "utf-8")
    .replace(/\r/g, "")
    .split("\n");

  let currentId = null;
  let currentQ = null;
  let currentA = [];

  const flush = () => {
    const answer = currentA.join("\n").trimEnd();

    if (currentId && currentQ && answer.trim()) {
      console.log("💾 Salvando chunk:", currentId);

      chunks.push({
        source_id: currentId,
        question: currentQ.trim(),
        answer: answer.trim(),
        content: `Q: ${currentQ.trim()}\nA:\n${answer}`.trim(),
      });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (isIdLine(line)) {
      flush();

      currentId = sanitizeId(line.replace(/[\[\]]/g, ""));
      console.log("🔖 Novo ID detectado:", currentId);

      currentQ = null;
      currentA = [];
      continue;
    }

    if (!currentId) continue;

    if (!currentQ) {
      if (trimmed) {
        currentQ = line;
        console.log("❓ Pergunta capturada:", currentQ);
      }
      continue;
    }

    currentA.push(line);
  }

  flush();
}

if (!chunks.length) {
  console.warn("⚠️ Nenhum chunk gerado.");
  process.exit(1);
}

fs.writeFileSync("chunks.json", JSON.stringify(chunks, null, 2));

console.log("\n✅ Chunks gerados:", chunks.length);
