require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3000);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ASSETS_PW = process.env.ASSETS_PASSWORD;
const DAM_BASE = "https://dam.ness-dev.tamedia.ch";

// --- DEFAULT PROMPTS ---

const DEFAULT_GENERATE_PROMPT = `You are a specialized translator that converts user input into WoodWing Assets search queries.
The asset metadata (name, description, tags) comes from wire agencies (AFP, DPA, EPA, Getty, Keystone, Reuters).
Metadata can be in English, German, or French depending on the agency.

Output ONLY valid JSON with three query variants — one per language. No explanations, no markdown, no backticks.
Format: {"en": "English query", "de": "German query", "fr": "French query"}

Rules for each query:
1. Extract the most distinctive keywords: proper nouns (people, places, organizations), event-specific terms.
2. Translate keywords into the target language of that query variant. Keep proper nouns as-is.
3. Use simple keyword searches — WoodWing full-text search matches across all metadata fields.
4. Prefer OR over AND to maximize recall. Use AND only between distinct concepts (e.g. location AND action). Group synonyms with OR.
5. Keep queries short: 2-5 key terms max. Fewer AND clauses is better — each one can eliminate results.
6. Wire agency descriptions use factual language. Prefer concrete words (knife, stabbing, police) over abstract ones (terror, crisis, violence).
7. For German queries, include both umlaut and non-umlaut spellings as OR alternatives (e.g. Türkei OR Tuerkei, jüdisch OR juedisch, Männer OR Maenner) since metadata may use either form.

Examples:
'Messerattacke in London auf jüdische Männer' -> {"en": "London AND (knife OR stabbing OR attack) AND (Jewish OR antisemitic)", "de": "London AND (Messer OR Messerattacke OR Angriff) AND (juedisch OR jüdisch OR antisemitisch)", "fr": "Londres AND (couteau OR attaque) AND (juif OR antisémite)"}
'Erdbeben in der Türkei' -> {"en": "earthquake AND Turkey", "de": "Erdbeben AND (Tuerkei OR Türkei)", "fr": "séisme AND Turquie"}
'recent images' -> {"en": "assetDomain:image AND created:[now-7d TO now]", "de": "assetDomain:image AND created:[now-7d TO now]", "fr": "assetDomain:image AND created:[now-7d TO now]"}`;

const DEFAULT_RATING_PROMPT = `Rate each image on a scale of 1–10 for how well it would work as a teaser image for the text above on a news website. Apply these criteria strictly:

1. People-centric (most important): The image MUST prominently feature people. Images without people score ≤ 3. Prefer images where faces and expressions are clearly visible.
2. Direct depiction: The image should literally show the subject of the article — the actual person, event, or scene described. Do NOT reward abstract or metaphorical imagery. A story about Netanyahu needs Netanyahu in the photo, not a generic politician.
3. Key figures recognizable: If the text names specific people, strongly prefer images where those individuals are identifiable. Named person visible = major score boost.
4. Action/event context: Prefer images showing people actively doing something — speaking, protesting, investigating, mourning, reacting — over static posed portraits or press photos.
5. Readable at small size: Teaser images are displayed as small thumbnails. Prefer simple, bold compositions with one or two clear subjects. Penalize images that are cluttered, have too many small details, or rely on elements that become illegible when scaled down.
6. Photojournalistic quality: Prefer candid, documentary-style wire agency photos that capture a real moment. Penalize stock-photo aesthetics or staged imagery.
7. Emotional impact: Prefer images that capture dramatic, tense, or emotionally charged moments that draw the reader in.

Scoring guide: 9-10 = named person/exact event clearly shown, tight framing, strong emotion. 6-8 = topically relevant people in context but not the exact subject. 3-5 = loosely related or poorly framed. 1-2 = no people, wrong subject, or irrelevant.

Return ONLY a valid JSON array, ranked from best (highest score) to worst. Use this exact format:
[{"imageIndex": 1, "name": "filename.jpg", "score": 8, "justification": "Brief reason why this image fits or doesn't"}]`;

// --- ROUTES ---

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));

/**
 * Return default prompts so the frontend can populate editable textareas
 */
app.get("/api/prompts", (req, res) => {
  res.json({
    generatePrompt: DEFAULT_GENERATE_PROMPT,
    ratingPrompt: DEFAULT_RATING_PROMPT,
  });
});

/**
 * 2. AI Query Generation (Claude Sonnet 4.6)
 */
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, systemPrompt: customPrompt } = req.body;

    const systemPrompt = customPrompt || DEFAULT_GENERATE_PROMPT;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    if (data.content && data.content[0]) {
      const raw = data.content[0].text.trim();
      const usage = data.usage || {};
      // Parse the JSON with en/de/fr queries
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const queries = JSON.parse(jsonMatch[0]);
        res.json({ query: queries.en, queries, systemPrompt, usage });
      } else {
        res.json({ query: raw, queries: { en: raw, de: raw, fr: raw }, systemPrompt, usage });
      }
    } else {
      res.status(400).json({ error: "Claude failed to generate a query." });
    }
  } catch (err) {
    console.error("Claude Error:", err);
    res.status(500).json({ error: "Failed to communicate with Claude." });
  }
});

/**
 * 3. WoodWing Assets Search Proxy
 */
app.post("/api/dam-search", async (req, res) => {
  const { query, queries } = req.body;

  try {
    // Step A: Login to WoodWing
    const loginResp = await fetch(`${DAM_BASE}/services/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "api.ai.lab",
        password: ASSETS_PW,
      }),
    });

    // Capture all session cookies
    const authCookie = loginResp.headers.getSetCookie().join("; ");

    if (!authCookie || !authCookie.includes("authToken")) {
      return res
        .status(401)
        .json({ error: "DAM Login failed. Check .env password." });
    }

    // Step B: Build list of queries to run (multilingual if available, else single)
    const queryList = queries
      ? Object.values(queries).filter(Boolean)
      : [query];

    // Step C: Run all language variants in parallel
    const searchResults = await Promise.all(
      queryList.map(async (q) => {
        const scopedQuery = `${q} AND ancestorPaths:"/Publishing/Wire feed"`;
        const searchResp = await fetch(
          `${DAM_BASE}/services/search?q=${encodeURIComponent(scopedQuery)}&num=25&appendRequestSecret=true`,
          {
            method: "GET",
            headers: { Cookie: authCookie },
          },
        );
        return searchResp.json();
      }),
    );

    // Step D: Merge and deduplicate hits by asset id (preserve order, primary language first)
    const seen = new Set();
    const mergedHits = [];
    let totalHits = 0;

    for (const data of searchResults) {
      totalHits += data.totalHits || 0;
      if (data.hits) {
        for (const hit of data.hits) {
          if (!seen.has(hit.id)) {
            seen.add(hit.id);
            mergedHits.push(hit);
          }
        }
      }
    }

    res.json({
      hits: mergedHits,
      totalHits,
      totalHitsUnique: seen.size,
    });
  } catch (err) {
    console.error("DAM Error:", err);
    res.status(500).json({ error: "Failed to communicate with WoodWing DAM." });
  }
});

/**
 * 4. AI Image Rating
 * Sends candidate images to Claude Vision for relevance rating against the search text.
 */
app.post("/api/rate-images", async (req, res) => {
  const { text, images, ratingPrompt: customRatingPrompt } = req.body;

  if (!images || !images.length) {
    return res.status(400).json({ error: "No images provided." });
  }

  try {
    // Step A: Login to WoodWing for thumbnail access
    const loginResp = await fetch(`${DAM_BASE}/services/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "api.ai.lab",
        password: ASSETS_PW,
      }),
    });
    const authCookie = loginResp.headers.getSetCookie().join("; ");

    // Step B: Fetch all thumbnails in parallel and convert to base64
    const fetchResults = await Promise.allSettled(
      images.map(async (img) => {
        if (!img.thumbnailUrl) return null;
        const resp = await fetch(img.thumbnailUrl, {
          headers: { Cookie: authCookie },
        });
        if (!resp.ok) return null;
        const buffer = await resp.arrayBuffer();
        const contentType = (
          resp.headers.get("content-type") || "image/jpeg"
        ).split(";")[0];
        return {
          name: img.name,
          description: img.description,
          tags: img.tags,
          base64: Buffer.from(buffer).toString("base64"),
          mediaType: contentType,
        };
      }),
    );

    const loaded = [];
    fetchResults.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) {
        loaded.push({ ...r.value, index: i + 1 });
      }
    });

    if (!loaded.length) {
      return res.status(400).json({ error: "Could not fetch any thumbnails." });
    }

    // Step C: Split into batches of 20 (Claude API image limit)
    const BATCH_SIZE = 20;
    const batches = [];
    for (let i = 0; i < loaded.length; i += BATCH_SIZE) {
      batches.push(loaded.slice(i, i + BATCH_SIZE));
    }

    const ratingSystemPrompt = customRatingPrompt || DEFAULT_RATING_PROMPT;

    // Step D: Send each batch to Claude in parallel
    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const content = [
          {
            type: "text",
            text: `Here is an article/text that needs an illustration for a news website:\n\n"${text}"\n\nBelow are ${batch.length} candidate images. Each image is followed by its number, filename, agency caption, and tags.`,
          },
        ];

        for (const img of batch) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType,
              data: img.base64,
            },
          });
          let label = `Image ${img.index}: "${img.name}"`;
          if (img.description) label += `\nCaption: ${img.description}`;
          if (img.tags && img.tags.length) label += `\nTags: ${img.tags.join(", ")}`;
          content.push({ type: "text", text: label });
        }

        content.push({ type: "text", text: ratingSystemPrompt });

        const claudeResp = await fetch(
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            headers: {
              "x-api-key": ANTHROPIC_KEY,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-6",
              max_tokens: 2000,
              messages: [{ role: "user", content }],
            }),
          },
        );

        const data = await claudeResp.json();
        const batchUsage = data.usage || {};

        let parsed = [];
        if (data.content && data.content[0]) {
          const raw = data.content[0].text.trim();
          const jsonMatch = raw.match(/\[[\s\S]*\]/);
          if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        }
        return { parsed, usage: batchUsage };
      }),
    );

    // Step E: Merge batch results and aggregate token usage
    const allRatings = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    for (const batch of batchResults) {
      allRatings.push(...batch.parsed);
      usage.input_tokens += batch.usage.input_tokens || 0;
      usage.output_tokens += batch.usage.output_tokens || 0;
    }
    const ratings = allRatings.sort((a, b) => b.score - a.score);
    res.json({ ratings, ratingPrompt: ratingSystemPrompt, usage });
  } catch (err) {
    console.error("Rating Error:", err);
    res.status(500).json({ error: "Failed to rate images with Claude." });
  }
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 TAMEDIA DAM EXPLORER`);
  console.log(`-----------------------`);
  console.log(`AI Model: Claude Sonnet 4.6`);
  console.log(`URL:      http://localhost:${PORT}`);
  console.log(`Ready for requests...\n`);
});
