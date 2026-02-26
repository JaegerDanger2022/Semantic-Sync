# Semantic Sync Backend

## Setup

1. Create a virtual environment.
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Set environment variables:
   - `ELASTIC_URL`
   - `ELASTIC_API_KEY`
   - `KIBANA_URL`
   - `AGENT_ID`

## Run

```bash
uvicorn main:app --reload --port 8000
```
