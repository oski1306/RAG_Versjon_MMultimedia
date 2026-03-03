if (typeof global.File === 'undefined') {
  global.File = class File {
    constructor(bits, filename, options = {}) {
      this.bits = bits;
      this.filename = filename;
      this.type = options.type || '';
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

if (typeof global.Blob === 'undefined') {
  global.Blob = class Blob {
    constructor(bits, options = {}) {
      this.bits = bits;
      this.type = options.type || '';
    }
  };
}

if (typeof global.FormData === 'undefined') {
  global.FormData = class FormData {
    constructor() {
      this.entries = [];
    }
    append(key, value) {
      this.entries.push([key, value]);
    }
  };
}

if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {
    constructor(...args) {
      this.a = 1; this.b = 0;
      this.c = 0; this.d = 1;
      this.e = 0; this.f = 0;
    }
  };
}

if (typeof global.ImageData === 'undefined') {
  global.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

if (typeof global.Path2D === 'undefined') {
  global.Path2D = class Path2D {
    constructor() {}
    moveTo() {}
    lineTo() {}
    arc() {}
    arcTo() {}
    closePath() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    rect() {}
    ellipse() {}
    addPath() {}
  };
}

if (typeof global.CanvasRenderingContext2D === 'undefined') {
  global.CanvasRenderingContext2D = class CanvasRenderingContext2D {
    moveTo() {}
    lineTo() {}
    stroke() {}
    fill() {}
    clearRect() {}
    fillRect() {}
    strokeRect() {}
    fillText() {}
    strokeText() {}
    measureText() { return { width: 0 }; }
    drawImage() {}
    createImageData() { return new global.ImageData(new Uint8ClampedArray(), 0, 0); }
    getImageData() { return new global.ImageData(new Uint8ClampedArray(), 0, 0); }
    putImageData() {}
    save() {}
    restore() {}
    scale() {}
    rotate() {}
    translate() {}
    transform() {}
    setTransform() {}
    resetTransform() {}
  };
}


(async () => {
  await import("dotenv/config");
  const { pool } = await import("./database.mjs");
  const cheerio = await import("cheerio");
  const { GoogleGenerativeAIEmbeddings } = await import("@langchain/google-genai");
  const fs = await import("fs");
  const path = await import("path");
  const { randomUUID } = await import("crypto");

  let pdfParse = null;
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfParse = async (buffer) => {
      const uint8Array = new Uint8Array(buffer);
      const pdf = await pdfjsLib.getDocument({ data: uint8Array }).promise;
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((item) => item.str).join(" ") + "\n";
      }
      return { text: text.trim() };
    };
  } catch (err) {
  }

  function chunkText(text, chunkSize = 500, overlap = 100) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
      chunks.push(text.slice(start, start + chunkSize));
      start += chunkSize - overlap;
    }

    return chunks;
  }

  function extractTextFromHTML(buffer) {
    const html = buffer.toString("utf8");
    const $ = cheerio.load(html);

    $("script, style, noscript").remove();
    return $("body").text().trim();
  }

  async function extractTextFromPDF(buffer) {
    if (!pdfParse) {
      console.log("⚠️ PDF parsing not available, skipping");
      return null;
    }
    try {
      const parsed = await pdfParse(buffer);
      return parsed && parsed.text ? parsed.text.trim() : null;
    } catch (err) {
      console.log("PDF parse error:", err.message);
      return null;
    }
  }

  const embeddings = new GoogleGenerativeAIEmbeddings({
    model: "models/gemini-embedding-001",
  });

  function toPgVector(vector) {
    return `[${vector.join(",")}]`;
  }

  async function ingestEmbeddings() {
    console.log("📥 Starting embedding ingestion...");

    const res = await pool.query(`
      SELECT 
        dc.document_id,
        dc.chunk_index,
        dc.content,
        dc.filename
      FROM document_chunks dc
      LEFT JOIN document_embeddings de
        ON de.document_id = dc.document_id
        AND de.chunk_index = dc.chunk_index
      WHERE de.id IS NULL
      ORDER BY dc.document_id, dc.chunk_index;
    `);

    console.log(`🧠 Chunks needing embeddings: ${res.rows.length}`);

    for (const row of res.rows) {
      try {
        console.log(`Embedding ${row.document_id}#${row.chunk_index}`);

        const vector = await embeddings.embedQuery(row.content);
        const pgVector = toPgVector(vector);

        await pool.query(
          `INSERT INTO document_embeddings
           (id, document_id, chunk_index, embedding, content, filename)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            row.document_id,
            row.chunk_index,
            pgVector,
            row.content,
            row.filename,
          ]
        );
      } catch (err) {
        console.error(`❌ Failed ${row.document_id}#${row.chunk_index}`);
        console.error(err.message);
      }
    }

    console.log("✅ Embedding ingestion finished");
  }

  async function runPipeline() {
    console.log("📁 Ingesting local documents from ./documents");
    const root = path.resolve("documents");
    const files = [];

    async function walk(dir) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && /\.(html?|txt|pdf)$/i.test(entry.name)) {
          files.push(full);
        }
      }
    }

    await walk(root);
    console.log(`📄 Found ${files.length} files`);

    const existingDocs = await pool.query(`
      SELECT DISTINCT filename FROM document_chunks
    `);
    const processedFilenames = new Set(
      existingDocs.rows.map(row => row.filename)
    );

    console.log(`📚 Already processed: ${processedFilenames.size} documents`);

    let newCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      try {
        const rel = path.relative(root, file).replace(/\\/g, "/");
        const position = rel.split("/")[0];
        let text = null;

        if (processedFilenames.has(rel)) {
          console.log(`⏭️  Already processed ${rel}`);
          skippedCount++;
          continue;
        }

        console.log(`⬇️ Processing ${rel}`);

        if (file.toLowerCase().endsWith(".pdf")) {
          const buffer = await fs.promises.readFile(file);
          text = await extractTextFromPDF(buffer);
        } else {
          const html = await fs.promises.readFile(file, "utf8");
          text = await extractTextFromHTML(Buffer.from(html, "utf8"));
        }

        if (!text || text.length < 200) {
          console.log(`⚠️ Skipping unusable file ${rel}`);
          continue;
        }

        const insertRes = await pool.query(
          `INSERT INTO documents (id, position)
           VALUES ($1, $2)
           RETURNING id`,
          [randomUUID(), position]
        );
        const docId = insertRes.rows[0].id;
        const chunks = chunkText(text);
        for (let i = 0; i < chunks.length; i++) {
          await pool.query(
            `INSERT INTO document_chunks
             (document_id, chunk_index, content, filename)
             VALUES ($1, $2, $3, $4)`,
            [docId, i, chunks[i], rel]
          );
        }

        console.log(`✅ Chunked ${rel} (${chunks.length} chunks)`);
        newCount++;
      } catch (err) {
        console.error(`❌ Error processing ${file}:`, err.message);
      }
    }

    console.log(`✂️ Chunking completed (${newCount} new, ${skippedCount} already processed)`);
    await ingestEmbeddings();
    await pool.end();
  }

  runPipeline().catch(err => {
    console.error("❌ Pipeline failed:", err);
    process.exit(1);
  });
})();