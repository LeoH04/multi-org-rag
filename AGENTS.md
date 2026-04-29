# AGENTS.md

Guidance for agents and contributors working in this repository.

## Project Overview

This repository runs the AIDAHO multi-service stack:

- `docker-compose.yml`: primary Docker Compose deployment for PostgreSQL, Tika, Open WebUI, n8n, nginx, backup, and `admin-monitor`.
- `admin-monitor/`: small Express API that exposes monitoring JSON under `/api/admin/...`.
- `landing/`: static HTML/CSS landing and monitoring pages.
- `k8s/`: Kubernetes manifests and nginx template. These are useful, but Docker Compose is the active path unless the user says otherwise.
- `init-multi-db.sql`: initial PostgreSQL database creation.

## Common Commands

Docker Compose:

```bash
docker compose config
docker compose up -d
docker compose ps
docker compose logs --tail=100 admin-monitor
docker compose logs --tail=100 nginx
docker compose restart nginx
```

Monitoring API checks:

```bash
curl -i http://localhost:3000/health
curl -i http://localhost:3000/api/admin/metrics/all
curl -i http://localhost/api/admin/metrics/all
```

Admin monitor local development:

```bash
cd admin-monitor
npm install
npm start
```

Kubernetes validation and apply:

```bash
kubectl kustomize k8s
kubectl apply -k k8s/
```

Nginx validation inside a running nginx container:

```bash
docker compose exec nginx nginx -t
docker compose exec nginx nginx -T
docker compose exec nginx nginx -s reload
```

## Deployment Notes

Docker Compose is the expected deployment mode for this server unless the user explicitly asks for Kubernetes.

The Compose stack has its own nginx service that mounts:

```text
k8s/nginx.conf.template -> /etc/nginx/templates/default.conf.template
landing/                 -> /usr/share/nginx/html
```

There may also be an outer production nginx stack outside this repo, for example under `/srv/nginx`. If public HTTPS behaves differently from `localhost`, inspect the active outer nginx config with:

```bash
docker compose -f /srv/nginx/docker-compose.yml exec nginx nginx -T
```

For deployed pages served under `/AIHub/`, relative API URLs like `./api/admin/metrics/all` resolve to `/AIHub/api/admin/metrics/all`. Either:

- make the HTML use absolute API paths like `/api/admin/metrics/all`, or
- configure the outer nginx to proxy `/AIHub/api/admin/` to `http://<app-host>:3000/api/admin/`.

Always verify the deployed API path returns JSON:

```bash
curl -i https://aidaho-tinkering-club.uni-hohenheim.de/api/admin/metrics/all
curl -i https://aidaho-tinkering-club.uni-hohenheim.de/AIHub/api/admin/metrics/all
```

Expected header:

```text
Content-Type: application/json; charset=utf-8
```

If the response starts with `<!DOCTYPE html>`, nginx is serving a static fallback instead of proxying the API.

## Workflow

1. Check current state first:

   ```bash
   git status --short
   docker compose config
   ```

2. Keep changes scoped. Avoid broad refactors across Docker, Kubernetes, and frontend files unless the request requires it.
3. For monitoring changes, verify both the direct API and the public/proxied path.
4. For nginx changes, run `nginx -t` before reload/restart.
5. For Kubernetes changes, run `kubectl kustomize k8s` before suggesting `kubectl apply -k k8s/`.
6. Do not overwrite user edits. If the worktree is dirty, inspect the relevant files and work with the existing changes.

## Coding Standards

JavaScript:

- Use ES modules, matching `admin-monitor/server.js`.
- Keep dependencies minimal. The API currently uses Express and `pg`.
- Return structured JSON for both success and error responses.
- Include timestamps in API responses with ISO strings.
- Prefer `async`/`await` and small helper functions.
- When building SQL dynamically, only use known, whitelisted table names. Keep user input parameterized.

Static frontend:

- The landing and admin pages are plain HTML/CSS/JavaScript with no build step.
- Keep UI copy in German where the existing page is German.
- Prefer absolute API paths (`/api/admin/...`) when pages may be hosted from subdirectories.
- Check `Content-Type` before calling `response.json()` so proxy errors produce useful messages.
- Keep CSS in `landing/assets/styles.css`; avoid adding framework dependencies for small UI changes.

Docker and nginx:

- Keep Docker service names stable because internal proxying depends on them.
- Keep nginx API locations more specific than static fallbacks, for example `location ^~ /api/admin/`.
- Avoid duplicate `location` blocks in the same `server` block; nginx will reject the config.
- If an outer nginx proxies to this stack, remember it may not share Docker DNS with `admin-monitor`. Use the app host IP, `host.docker.internal` with `host-gateway`, or attach the outer nginx container to the Compose network.

Security:

- Do not add secrets, API keys, passwords, or tokens to new files.
- Treat `.env`, `k8s/secret.yaml`, and compose-rendered environment output as sensitive.
- Avoid pasting secrets into logs, docs, or final responses.

## Useful Troubleshooting

Direct API works, public page fails with `Unexpected token '<'`:

```bash
curl -i http://localhost:3000/api/admin/metrics/all
curl -i https://<public-host>/api/admin/metrics/all
```

If direct returns JSON and public returns HTML, fix the public nginx `server`/`location` routing.

Find the active nginx block:

```bash
docker compose exec nginx nginx -T | grep -n -B20 -A60 "server_name"
docker compose exec nginx nginx -T | grep -n -B8 -A20 "api/admin"
```

Common causes:

- API `location` is in the wrong `server_name` block.
- A relative frontend URL points at `/AIHub/api/admin/...` while nginx only proxies `/api/admin/...`.
- Duplicate nginx `location` blocks prevent reload.
- The edited file is not the file mounted into the running nginx container.
