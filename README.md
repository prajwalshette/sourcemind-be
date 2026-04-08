# 🧠 URL RAG Backend — Production Setup Guide

**Stack:** TypeScript · Express · Prisma · PostgreSQL · Qdrant · Redis · Ollama (100% FREE)**

---

## ⚡ Quick Start (Docker)

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env — set JWT_SECRET (min 32 chars)

# 2. Start all services + pull free AI models
docker-compose up -d

# 3. Run DB migrations
docker-compose exec api npx prisma migrate deploy

# 4. Done! API is running
curl http://localhost:3000/api/v1/health
```

---

## 🛠️ Local Development

### Prerequisites
- Node.js 20+
- Docker (for Postgres, Redis, Qdrant)
- [Ollama](https://ollama.com/download) installed locally

### Step 1: Install dependencies
```bash
npm install
```

### Step 2: Start infrastructure
```bash
# Start Postgres, Redis, Qdrant
docker-compose up postgres redis qdrant -d
```

### Step 3: Pull free AI models (one-time)
```bash
# Install Ollama: https://ollama.com/download
ollama pull nomic-embed-text       # Free embedding model (768d)
ollama pull llama3.2:3b             # Default LLM (~2GB RAM)

# Heavier / more accurate (needs ~4.5GB RAM):
# ollama pull mistral:7b-instruct
# ollama pull phi3:mini            # Very fast, 3.8B
```

### Step 4: Setup database
```bash
cp .env.example .env               # Configure your .env
npx prisma migrate dev --name init # Run migrations
npx prisma generate                # Generate client
```

### Step 5: Start dev server
```bash
npm run dev
```

---

## 📡 API Reference

### Authentication

#### Register (creates tenant + admin user)
```bash
POST /api/v1/auth/register
Content-Type: application/json

{
  "tenantName": "My Company",
  "email": "admin@mycompany.com",
  "password": "securepassword"
}

# Response:
{
  "success": true,
  "data": {
    "token": "eyJhbGci...",
    "apiKey": "uuid-api-key",   ← use this for API calls
    "user": { "id": "...", "email": "...", "role": "ADMIN" },
    "tenant": { "id": "...", "name": "...", "plan": "FREE" }
  }
}
```

#### Login
```bash
POST /api/v1/auth/login
{ "email": "...", "password": "..." }
```

---

### Ingest URL

```bash
# Async (recommended) — queues job, returns immediately
POST /api/v1/documents/ingest
X-Api-Key: your-api-key
Content-Type: application/json

{
  "url": "https://docs.example.com/getting-started",
  "async": true,
  "webhookUrl": "https://yourapp.com/webhook",  # optional
  "crawlAllPages": true,                         # optional (spider whole site)
  "maxPages": 20                                 # optional (cap, default 20)
}

# Response: 202 Accepted
{
  "success": true,
  "data": { "documentId": "uuid", "status": "PENDING" }
}

# Synchronous (waits for completion)
{ "url": "https://...", "async": false, "crawlAllPages": false }
```

### List Documents
```bash
GET /api/v1/documents?page=1&limit=20&status=INDEXED
X-Api-Key: your-api-key
```

### Delete Document
```bash
DELETE /api/v1/documents/:id
X-Api-Key: your-api-key
```

### Re-index Document
```bash
POST /api/v1/documents/:id/reindex
X-Api-Key: your-api-key
```

---

### Query

```bash
POST /api/v1/query
X-Api-Key: your-api-key
Content-Type: application/json

{
  "question": "What are the system requirements?",
  "documentId": "optional-uuid",   # omit to search all docs
  "topK": 5,
  "useCache": true
}

# Response:
{
  "success": true,
  "data": {
    "answer": "The system requires...",
    "sources": [
      {
        "url": "https://docs.example.com/requirements",
        "section": "System Requirements",
        "excerpt": "The application needs...",
        "score": 0.87
      }
    ],
    "model": "mistral:7b-instruct",
    "confidence": 0.87,
    "fromCache": false,
    "latencyMs": 1240,
    "promptTokens": 3200,
    "completionTokens": 180
  }
}
```

### Query History
```bash
GET /api/v1/query/history?page=1&limit=20
X-Api-Key: your-api-key
```

### Usage Stats
```bash
GET /api/v1/usage
X-Api-Key: your-api-key
```

---

## 🆓 Free Models

| Component  | Model                    | Dims | How to Get           |
|------------|--------------------------|------|----------------------|
| Embeddings | nomic-embed-text         | 768  | `ollama pull nomic-embed-text` |
| LLM (default) | llama3.2:3b           | -    | `ollama pull llama3.2:3b` |
| LLM (larger) | mistral:7b-instruct   | -    | `ollama pull mistral:7b-instruct` |
| LLM (tiny) | phi3:mini                | -    | `ollama pull phi3:mini` |
| Embed FB   | BAAI/bge-small-en-v1.5   | 384  | HuggingFace Free API |

All models are **100% free** and run **locally** via Ollama.

---

## 🏗️ Architecture

```
User → POST /api/v1/documents/ingest
         ↓
      [BullMQ Queue]
         ↓
      [Ingestion Worker]
         ├── Crawl4AI URL Loader (Tier 1, self-hosted)
         ├── Cheerio URL Loader (Tier 2)
         ├── Firecrawl URL Loader (Tier 3, fallback)
         ├── Playwright URL Loader (Tier 4, last resort)
         ├── Markdown/Recursive Chunker (800 tok / 150 overlap)
         ├── Ollama nomic-embed-text (768d, free)
         ├── Qdrant upsert (vector store)
         └── PostgreSQL (metadata via Prisma)

User → POST /api/v1/query
         ↓
      [Redis cache check]
         ↓ (miss)
      [Embed query → Ollama]
         ↓
      [Qdrant vector search (top-20)]
         ↓
      [MMR rerank (top-10 → top-5)]
         ↓
      [Ollama LLM generate]
         ↓
      [Cache result in Redis]
         ↓
      Answer + Sources + Confidence
```

---

## 🔧 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| DATABASE_URL | ✅ | - | PostgreSQL connection string |
| JWT_SECRET | ✅ | - | Min 32 chars |
| OLLAMA_BASE_URL | - | http://localhost:11434 | Ollama server |
| OLLAMA_LLM_MODEL | - | llama3.2:3b | LLM model |
| OLLAMA_EMBED_MODEL | - | nomic-embed-text | Embedding model |
| HF_API_KEY | - | - | HuggingFace (fallback) |
| CRAWL4AI_BASE_URL | - | http://localhost:11235 | Crawl4AI (Tier 1) base URL |
| FIRECRAWL_API_KEY | - | - | Firecrawl (Tier 3 fallback) |
| QDRANT_URL | - | http://localhost:6333 | Qdrant server |
| REDIS_URL | - | redis://localhost:6379 | Redis server |

---

## 🚀 Production Deployment

```bash
# Build
npm run build

# Run migrations
npx prisma migrate deploy

# Start
NODE_ENV=production npm start
```

### Nginx config
```nginx
server {
    listen 80;
    server_name api.yourapp.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 📊 Prisma Commands

```bash
npx prisma migrate dev --name <name>  # Create migration
npx prisma migrate deploy             # Apply migrations (prod)
npx prisma studio                     # GUI for database
npx prisma generate                   # Regenerate client
npx prisma db push                    # Push schema (dev only)
```
