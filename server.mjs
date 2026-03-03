import "dotenv/config";
import express from "express";
import { pool } from "./database.mjs";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import path from "path";

const app = express();

app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

app.use(express.json());
app.use(express.static("public"));
app.use("/docs", express.static("documents"));

const model = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash",
  temperature: 0
});

const embeddings = new GoogleGenerativeAIEmbeddings({
  model: "models/gemini-embedding-001"
});

function sanitizeCitations(answer, maxId) {
  return answer.replace(/\[(\d+)\]/g, (match, id) => {
    const num = Number(id);
    if (num < 1 || num > maxId) return "";
    return match;
  });
}

function isGreeting(text) {
  return /^(hi|hello|hey|hei|hallo)\b/i.test(text.trim());
}

function toPgVector(vector) {
  return `[${vector.join(",")}]`;
}

function noDocsResponse(res) {
  return res.json({
    answer: "Jeg fant ingen relevante dokumenter.",
    citations: []
  });
}

const prompt = PromptTemplate.fromTemplate(`
Du er en AI-drevet søkeassistent.

Oppgave:
Forklar KUN dokumentene gitt i konteksten.

REGLER (OBLIGATORISK):
- Ikke bruk ekstern kunnskap
- Beskriv kun dokumentene i DOCUMENTS
- Svar kun på norsk
- Du MÅ beskrive EXACTLY {doc_count} dokumenter
- For hvert dokument skriv NØYAKTIG to setninger: først en kort beskrivelse, så en setning som forklarer hvorfor dokumentet er relevant for spørsmålet.
- Hvis ingen av dokumentene dekker spørsmålet, si tydelig at du ikke finner noe relevant og ikke dikt opp noe

FORMAT:

[1] dokumentnavn  
Kort beskrivelse av innholdet.
Forklaring på hvorfor det er relevant i sammenheng med spørsmålet.

DOCUMENTS:
{doc_list}

CONTENT:
{context}

Spørsmål:
{question}
`);

const ragChain = RunnableSequence.from([
  prompt,
  model,
  new StringOutputParser()
]);


app.get("/positions", async (req, res) => {
  try {
    const result = await pool.query(`
    SELECT DISTINCT position
    FROM documents
    WHERE position IS NOT NULL
    ORDER BY position`
    );

    res.json(
      result.rows
        .map(r => r.position?.trim())
        .filter(Boolean)
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/ask", async (req, res) => {
  const { question, position } = req.body;

  if (!question) {
    return res.status(400).json({ error: "Missing question" });
  }

  if (isGreeting(question)) {
    return res.json({
      answer: "Hei! 👋 Hvordan kan jeg hjelpe deg?",
      citations: []
    });
  }

  try {
    console.log(`🔎 Question: ${question}`);

    const queryEmbedding = await embeddings.embedQuery(question);
    const pgVector = toPgVector(queryEmbedding);

    const positionFilter = position === "ALL" ? null : position;

    const results = await pool.query(`
      SELECT
         de.id,
         de.document_id,
         de.chunk_index,
         de.content,
         de.filename,
         d.position,
         de.embedding <-> $1::vector AS distance
      
      FROM document_embeddings de
      JOIN documents d ON d.id = de.document_id
      
      WHERE (
        $2::text IS NULL
        OR d.position = $2
      )
      
      ORDER BY distance ASC
      LIMIT 6
    `, [pgVector, positionFilter]);

    if (!results.rows.length) {
      return noDocsResponse(res);
    }

    const MAX_DISTANCE = 0.8;

    let relevantRows = results.rows.filter(row => row.distance < MAX_DISTANCE);

    if (!relevantRows.length) {
      return noDocsResponse(res);
    }

    const queryWords = question.toLowerCase().split(/\W+/).filter(w => w && w.length > 2);
    const hasKeywordMatch = relevantRows.some(row => {
      const content = row.content.toLowerCase();
      return queryWords.some(w => content.includes(w));
    });
    if (!hasKeywordMatch) {
      return noDocsResponse(res);
    }

    const docsBySource = new Map();

    relevantRows.forEach(row => {
      const source = path.basename(row.filename);

      if (!docsBySource.has(source)) {
        docsBySource.set(source, {
          document_id: row.document_id,
          chunks: [],
          preview: row.content,
          path: row.filename
        });
      }

      docsBySource.get(source).chunks.push(row.content);
    });

    const documents = Array.from(docsBySource.entries()).map(
      ([source, data], index) => ({
        id: index + 1,
        source,
        path: data.path,
        document_id: data.document_id,
        content: data.chunks.join("\n\n"),
        preview: data.preview.slice(0, 300) + "..."
      })
    );

    const docList = documents
      .map(d => `[${d.id}] ${d.source}`)
      .join("\n");

    const context = documents
      .map(d => `[${d.id}] ${d.content}`)
      .join("\n\n");

    const rawAnswer = await ragChain.invoke({
      question,
      context,
      doc_list: docList,
      doc_count: documents.length
    });

    const answer = sanitizeCitations(rawAnswer, documents.length);

    res.json({
      answer,
      citations: documents.map(d => ({
        id: d.id,
        source: d.source,
        preview: d.preview,
        path: encodeURI(d.path),
        documentId: d.document_id
      }))
    });

  } catch (err) {
    console.error("❌ Server error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/classic-search", async (req, res) => {
  const { query, mode } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    let rows;
    if (mode === "id") {
      rows = await pool.query(
        `SELECT d.id, dc.filename
         FROM documents d
         LEFT JOIN document_chunks dc ON dc.document_id = d.id
         WHERE d.id::text LIKE $1
         GROUP BY d.id, dc.filename
         ORDER BY d.id`,
        [`%${query}%`]
      );
    } else {
      rows = await pool.query(
        `SELECT DISTINCT d.id, dc.filename
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.filename ILIKE $1`,
        [`%${query}%`]
      );
    }

    const results = rows.rows.map(r => {
      const filename = r.filename || "";
      return {
        id: r.id,
        internalId: r.id,
        name: path.basename(filename) || `Doc ${r.id}`,
        url: encodeURI(`/docs/${filename}`)
      };
    });

    res.json({ results });
  } catch (err) {
    console.error("Search Error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
