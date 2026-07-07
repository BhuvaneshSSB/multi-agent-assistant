# Streamlit frontend

Chat UI for the multi-agent-assistant. Talks to the single `POST /api/chat`
endpoint on the Mastra backend (multipart form: `conversationId`, `userId`,
`message`, optional `file`).

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

Make sure the backend is running first (`npm run dev` from the repo root,
default `http://localhost:3000`), then:

```bash
streamlit run app.py
```

Set `API_BASE_URL` env var if the backend runs on a different host/port.
