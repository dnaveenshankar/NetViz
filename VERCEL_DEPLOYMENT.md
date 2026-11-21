# Deploy NetViz 3.0 on Vercel

NetViz uses Vercel's current FastAPI framework preset. The root `app.py` is a supported FastAPI entrypoint, and `vercel.json` explicitly selects the `fastapi` framework. Vercel bundles the FastAPI application, Jinja template, static CSS/JavaScript, quiz bank, and graphical simulations into the Python deployment.

An additional `api/index.py` ASGI entrypoint is included for compatibility and for local serverless-style testing, but the normal Vercel deployment uses the detected root `app.py` preset.

## Important persistence behavior

Vercel Functions have a read-only deployment bundle and an ephemeral writable `/tmp` directory. NetViz automatically uses `/tmp/netviz.db` on Vercel so the application can start and all labs can run.

The following SQLite data is **not guaranteed to survive** a cold start, redeployment, region change, or request routed to another function instance:

- Registered accounts and passwords
- Saved custom topologies
- Quiz scores
- DHCP leases
- Challenge and simulation records

The signed session identity is re-created in a fresh instance when possible, preventing normal authenticated demo actions from failing after a cold start. This does not make saved SQLite records durable.

For a public classroom deployment requiring permanent multi-user data, replace SQLite with a managed database such as Vercel Postgres/Neon, Turso, or another durable service before relying on accounts and saved results. The visual simulations themselves run in the browser and do not require durable storage.

## Required environment variable

Create a stable session secret:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Add the output to Vercel as:

```text
NETVIZ_SECRET_KEY=<generated value>
```

Add it to **Production**, **Preview**, and **Development** environments as needed. Never commit the generated value.

Vercel automatically exposes its `VERCEL` runtime variable. `app.py` detects that variable, enables secure cookies, and chooses `/tmp/netviz.db`. The compatibility entrypoint also sets `NETVIZ_HTTPS_ONLY=1`, `NETVIZ_SERVERLESS=1`, and `NETVIZ_DATABASE=/tmp/netviz.db` when invoked directly.

## Deploy using the Vercel CLI

Install and authenticate the CLI:

```bash
npm install -g vercel
vercel login
```

From the project root:

```bash
cd NetViz
vercel
```

During the first deployment:

1. Create or link a Vercel project.
2. Keep the project root as `.`.
3. Vercel should display the FastAPI framework preset; `vercel.json` also declares it explicitly.
4. Add `NETVIZ_SECRET_KEY` in the Vercel dashboard or with the CLI.

Add the secret through the CLI if preferred:

```bash
vercel env add NETVIZ_SECRET_KEY production
vercel env add NETVIZ_SECRET_KEY preview
```

Deploy production:

```bash
vercel --prod
```

## Deploy from GitHub, GitLab, or Bitbucket

1. Push the contents of this folder to a repository.
2. In Vercel, choose **Add New → Project** and import the repository.
3. If NetViz is in a monorepo, set **Root Directory** to the NetViz folder.
4. Add `NETVIZ_SECRET_KEY` under **Settings → Environment Variables**.
5. Deploy.

Vercel detects FastAPI in `requirements.txt`, finds the supported `app.py` entrypoint, and routes the deployment through the FastAPI framework preset.

## Local Vercel-style testing

Install production dependencies:

```bash
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Test the normal local server:

```bash
python app.py
```

Test the Vercel entrypoint directly:

```bash
NETVIZ_SECRET_KEY=local-test-secret \
NETVIZ_SERVERLESS=1 \
NETVIZ_DATABASE=/tmp/netviz-vercel-test.db \
NETVIZ_HTTPS_ONLY=0 \
uvicorn api.index:app --reload
```

Or use the Vercel development runtime:

```bash
vercel dev
```

Open `http://localhost:3000` for `vercel dev` or `http://127.0.0.1:8000` for the Uvicorn entrypoint test.

## Verify after deployment

Open these endpoints on the deployed domain:

```text
/api/health
/api/deployment
```

Expected deployment fields include:

```json
{
  "runtime": "vercel-serverless",
  "platform": "vercel",
  "serverless": true,
  "database_path": "/tmp/netviz.db",
  "persistence": "ephemeral",
  "session_secret_configured": true
}
```

Then verify:

1. The light NetViz interface loads.
2. Guest access creates a session.
3. `/static/css/light.css` and `/static/js/v3.js` return HTTP 200.
4. A blank topology and all five templates open.
5. Mobile, messaging, TCP/UDP, subnet, DHCP, DNS, media, quiz, and challenge labs run.

## DNS behavior on Vercel

In local deployment, DNS lookups use the local computer/server resolver. On Vercel, A, AAAA, and PTR lookups use the resolver configured inside the Vercel Function runtime—not the visitor's personal computer resolver. All other networking journeys remain educational simulations.
