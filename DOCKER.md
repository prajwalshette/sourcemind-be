# Run URL RAG backend with Docker (no local install)

All services run in containers: Postgres, Redis, Qdrant, Ollama (LLM + embeddings), and the API. Nothing is installed on your machine except Docker.

## 1. Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Docker Compose) installed and running.

## 2. Environment

Create a `.env` in `url-rag-be` with at least:

```env
JWT_SECRET=your-super-secret-jwt-key-at-least-32-characters-long
```

Optional (for fallbacks):

```env
FIRECRAWL_API_KEY=fc-xxx
HF_API_KEY=hf_xxx
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

Use your existing `.env`; Docker Compose will load it and override only the URLs to use container hostnames.

## 3. Start everything

From the `url-rag-be` directory:

```bash
cd url-rag-be
docker compose up -d
```

This starts:

- **postgres** (5432)
- **redis** (6379)
- **qdrant** (6333)
- **ollama** (11434)
- **ollama-setup** (one-off: pulls `nomic-embed-text` and `llama3.2:3b`, removes old `mistral:7b-instruct` if present)
- **api** (3000) — after Postgres, Redis, Qdrant, and Ollama are up

## 4. Wait for Ollama models (first run)

The first time, Ollama needs to download the models (~2GB for llama3.2:3b). Check the setup container:

```bash
docker logs -f rag_ollama_setup
```

Wait until you see: `✅ Models ready`. Then the API can answer queries.

## 5. Run the frontend (local)

Point the frontend at the API in Docker:

```bash
cd url-rag-fe
echo "VITE_APP_BASE_URL=http://localhost:3000" > .env
pnpm install
pnpm dev
```

Open http://localhost:5173 and use the app. API is at http://localhost:3000/api/v1.

## 6. Useful commands

```bash
# View API logs
docker logs -f rag_api

# Stop all
docker compose down

# Stop and remove volumes (reset DB, Redis, Qdrant, Ollama models)
docker compose down -v
```

## 7. Playwright (Tier 3 URL loader)

The API image does **not** include Playwright/Chromium (heavy and not needed if Firecrawl is set). If you want Tier 3 fallback inside Docker, you’d need a custom Dockerfile that installs Playwright and its browsers; for most cases Cheerio + Firecrawl in Docker is enough.
