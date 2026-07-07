# Setup

## Prerequisites

- **Node.js 22+** (see `engines` in `package.json`)
- **PostgreSQL with the `pgvector` extension** — either via the provided Docker Compose service, or your own instance
- **OpenAI API key** (required — used for chat models, embeddings, and the observational-memory model)
- **Anthropic API key** (optional — enables cross-provider fallback on every agent; without it, agents just retry OpenAI on transient failures)
- **NewsAPI key** (optional — enables the news source in the Research Agent's web search; the other sources, DuckDuckGo and Wikipedia, work without it)
- **Python 3.9+** (only if you want to run the Streamlit frontend outside Docker)

## Environment variables

Create a `.env` file in the project root:

```bash
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/multi_agent


ANTHROPIC_API_KEY=sk-ant-...
NEWS_API_KEY=...
API_PORT=3000
NODE_ENV=development
```

If you're using the Docker Compose Postgres service as-is, `DATABASE_URL` above (`localhost:5432`, user/pass/db all `postgres`/`postgres`/`multi_agent`) matches its defaults — only override `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` if you want different credentials.

## Option A: Local development (Node on host, Postgres in Docker)

1. **Start Postgres** (with `pgvector` already installed, and `scripts/init.sql` applied automatically on first boot):

   ```bash
   docker compose up -d postgres
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Run the API in watch mode:**

   ```bash
   npm run dev
   ```

   This starts the Express server on `http://localhost:3000`, initializes the Postgres pool, and registers all Mastra agents/workflows.



## Option B: Full stack in Docker (Postgres + backend + Streamlit frontend)

```bash
docker compose up -d --build
```

This brings up three services:

- `postgres` → `localhost:5432` (with a healthcheck gating the other two)
- `backend` → `localhost:3000`
- `frontend` (Streamlit) → `localhost:8501`

The backend container reads its environment from your `.env` file (`env_file: .env` in `docker-compose.yml`); make sure it exists before starting. Note `DATABASE_URL` is overridden inside Compose to point at the `postgres` service hostname rather than `localhost`.

## Running the Streamlit frontend standalone (without Docker)

```bash
cd streamlit-frontend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

Make sure the backend is already running (`npm run dev`, default `http://localhost:3000`). If it's on a different host/port, set `API_BASE_URL` before running `streamlit run`.

## Verifying it's working

With the backend running:

- **Health check:** `curl http://localhost:3000/health`
- **API docs (Swagger UI):** open `http://localhost:3000/api-docs`
- **Registered agents:** `curl http://localhost:3000/api/agents`
- **System status:** `curl http://localhost:3000/api/status`

### Send a chat message

```bash
curl -X POST http://localhost:3000/api/chat \
  -F "conversationId=$(uuidgen)" \
  -F "userId=$(uuidgen)" \
  -F "message=What is Mastra?"
```

### Upload a document and ask about it

```bash
CONV=$(uuidgen)
USER=$(uuidgen)

# Upload — ingestion runs synchronously and returns chunk counts
curl -X POST http://localhost:3000/api/chat \
  -F "conversationId=$CONV" \
  -F "userId=$USER" \
  -F "message=Summarize this document" \
  -F "file=@/path/to/your/file.pdf"

# Follow-up question in the same conversation — retrieval-gate finds the
# relevant chunks and routes to the Document Agent automatically
curl -X POST http://localhost:3000/api/chat \
  -F "conversationId=$CONV" \
  -F "userId=$USER" \
  -F "message=What does it say about pricing?"
```

Supported document formats: `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.csv`.

## Useful scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the API with hot reload (`tsx watch`) |
| `npm run studio` | Launch Mastra Studio (agent/workflow/trace inspector) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the compiled build (`dist/app.js`) |
| `npm run type-check` | Type-check without emitting |

## Troubleshooting

- **"Database not initialized" / connection errors on startup:** confirm Postgres is up (`docker compose ps`) and `DATABASE_URL` in `.env` matches its credentials/port.
- **Embeddings/chat calls fail with an auth error:** `OPENAI_API_KEY` is missing or invalid — it's required even if you only intend to use Anthropic as a fallback, since embeddings and the observational-memory model are OpenAI-only in the current config.
- **PPTX/XLSX/DOCX upload fails to parse:** confirm the file extension matches its actual format — the API validates by extension (`pdf`, `docx`, `xlsx`, `pptx`, `csv`) before attempting to parse.
