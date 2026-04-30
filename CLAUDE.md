# Tamedia DAM AI Explorer

## What this is

A Node.js/Express proxy that lets users search the Tamedia WoodWing Assets DAM using natural language. Claude Sonnet 4.6 translates user prompts into WoodWing search syntax, then the server proxies the search request to the DAM API.

## Architecture

- **`server.js`** — Express backend with 4 routes:
  - `GET /` — serves `index.html`
  - `POST /api/generate` — sends user prompt to Claude, returns multilingual query variants (`{ query, queries: { en, de, fr } }`)
  - `POST /api/dam-search` — logs into WoodWing DAM, runs all language variants in parallel, merges/dedupes hits by asset id
  - `POST /api/rate-images` — fetches thumbnails from the DAM, batches them (20 per call) to Claude Vision, returns 1–10 relevance scores against a given article text
- **`index.html`** — single-file frontend (Tailwind via CDN, vanilla JS, no build step)
- No TypeScript, no bundler, no test framework

## Tech stack

- Node.js >= 18 (uses native `fetch`)
- Express 4, cors, dotenv
- Claude API (`claude-sonnet-4-6`, Anthropic messages endpoint)
- WoodWing Assets REST API at `https://dam.ness-dev.tamedia.ch`

## Commands

```bash
npm start        # Production: node server.js
npm run dev      # Development: node --watch server.js (auto-restart on changes)
```

Server runs on `http://localhost:3000` (or `PORT` env var).

## Environment variables (.env)

- `ANTHROPIC_API_KEY` — Anthropic API key for Claude
- `ASSETS_PASSWORD` — password for the `api.ai.lab` WoodWing DAM account

**Never commit `.env` or expose these secrets.**

## DAM search details

- DAM user: `api.ai.lab`
- All searches are scoped to `ancestorPaths:"/Publishing/Wire feed"`
- Wire feed metadata (name, description, tags) comes from agencies: AFP, DPA, EPA, Getty, Keystone, Reuters — language varies (English, German, French) by agency
- The AI system prompt instructs Claude to emit one query per language (`en`/`de`/`fr`) as a JSON object, using OR-heavy queries for recall and including umlaut/non-umlaut spellings on German terms

## Code conventions

- CommonJS (`require`/`module.exports`), not ESM
- No linting or formatting tools configured
- Inline comments where needed, no JSDoc beyond the existing route comments
