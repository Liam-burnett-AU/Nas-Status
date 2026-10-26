# NAS Status

A polished status page for **Nextcloud**, powered by the official
[serverinfo](https://github.com/nextcloud/serverinfo) external monitoring API.

It checks your server every minute, keeps its own history, works out uptime and
incidents, and presents everything on a dark, fast, dependency-free dashboard.
It is built to run on **Cloudflare Workers** (free plan), and can also run as a
plain Node.js server or Docker container on your own hardware.

![Desktop screenshot](docs/screenshot.png)

<details>
<summary>Mobile layout</summary>

![Mobile screenshot](docs/screenshot-mobile.png)

</details>

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Deploy to Cloudflare Workers](#deploy-to-cloudflare-workers)
- [Monitoring your other apps](#monitoring-your-other-apps)
- [Email alerts](#email-alerts)
- [Alternative: run on your own server](#alternative-run-on-your-own-server)
- [Configuration](#configuration)
- [How status is decided](#how-status-is-decided)
- [JSON API](#json-api)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Features

- **Live overall status** with an animated status orb, plus 24 h, 7 d, 30 d and 90 d availability.
- **Email alerts.** A message when Nextcloud or any app goes down, and another when it is back, through your Mail Relay.
- **Your other apps too.** Every site or API you list is checked each minute and shown as up, slow or down, with response time, a 24-hour trend and 90 days of history.
- **Four monitored components:** web and file sync, server API and database, storage, and CPU and memory.
- **90-day uptime bars** for each component, in the style of hosted status pages. Every day has a tooltip breakdown.
- **Interactive charts** for response time, CPU, memory, swap, free storage, active users and API latency.
  - Choose a 1 h, 6 h, 24 h or 7 d range.
  - Crosshair tooltips work with the mouse, touch or keyboard.
  - Outage periods are shaded, and every chart has a table view.
- **Radial gauges** for CPU, memory, swap and storage, plus CPU temperatures when available.
- **Detail tables** cover system versions, usage, shares (with a donut chart), active users, PHP and caching (OPcache and APCu hit rates), app updates and disk volumes.
- **Automatic incident history.** Incidents open and close from consecutive checks and include a timeline of updates.
- **Built for real-world failures.**
  - Timeouts, refused connections, maintenance mode and bad tokens are each handled and explained.
  - The last good figures are kept and clearly marked as stale.
- **Zero runtime dependencies.** The page loads nothing from the internet, and the same code runs on Cloudflare Workers or Node.js 18.17+.
- **Fits the Cloudflare free plan.** One Durable Object, an alarm per check and about 6,000 storage writes a day.
- **Also ready for Docker,** with a health check, a non-root user and a persistent data volume.
- **Demo mode** lets you preview the page with 90 days of realistic generated data.

## How it works

```
Browser ──► Cloudflare Worker ──────────────► Nextcloud (public host name)
            │ static page (free, unlimited)     ├─ /status.php                      reachability, maintenance
            │ /api/* ─► Durable Object          ├─ …/serverinfo/api/v1/info         NC-Token
            │           • alarm every 60 s       ├─ …/diskdata    (optional, admin app password)
            │           • history in SQLite      └─ …/basicdata   (optional, admin app password)
            └ cron every 5 min: watchdog that keeps the alarm armed
```

The browser never talks to Nextcloud directly. Your token stays in a Worker
secret, and cross-origin (CORS) problems are avoided entirely.

| Data | Kept for |
| --- | --- |
| Raw checks | 7 days |
| Daily summaries | 90 days |
| Incidents | 90 days |

On Workers this lives in the Durable Object's built-in SQLite storage. On Node.js
it lives in `data/history.json`, written atomically every five minutes and on
shutdown.

## Deploy to Cloudflare Workers

### 1. Create a monitoring token on Nextcloud

The serverinfo app ships with Nextcloud and is enabled by default. Generate a long
random token and store it in Nextcloud's app config.

```bash
# Standard install (adjust the path and web server user to suit)
sudo -u www-data php /var/www/nextcloud/occ config:app:set serverinfo token --value "$(openssl rand -hex 32)"

# Nextcloud All-in-One
sudo docker exec --user www-data -it nextcloud-aio-nextcloud php occ config:app:set serverinfo token --value "$(openssl rand -hex 32)"

# Read the token back so you can copy it
sudo -u www-data php /var/www/nextcloud/occ config:app:get serverinfo token
# ...or on All-in-One
sudo docker exec --user www-data nextcloud-aio-nextcloud php occ config:app:get serverinfo token
```

**TrueNAS SCALE app** (24.10 or later): find the container name, then run `occ` inside it.

```bash
sudo docker ps --format '{{.Names}}' | grep -i nextcloud     # use the one ending in nextcloud-1
sudo docker exec -u www-data ix-nextcloud-nextcloud-1 php occ config:app:get serverinfo token
sudo docker exec -u www-data ix-nextcloud-nextcloud-1 php occ config:app:set serverinfo token --value "$(openssl rand -hex 32)"
```

If you paste several lines into zsh, leave out lines starting with `#`. zsh does not treat them as comments by default.

> Run the `set` command **once**. Every run creates a new token and the old one
> stops working.

### 2. Make sure Cloudflare can reach your Nextcloud

The Worker runs in Cloudflare's network, not on your LAN, so Nextcloud needs a
public **host name** over HTTPS.

- **Workers cannot fetch IP addresses.** `https://203.0.113.10` will not work. Use a DNS name.
- **A NAS on a home connection** is easiest to expose with a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), for example `cloud.yourdomain.com`.
- **Behind Cloudflare Access?** Let the monitor through with a service token (see below).
- **Bot Fight Mode blocks Workers.** If it is on for the domain, turn it off under *Security → Bots*. On the free plan it cannot be skipped per path.
- **Stick to port 443.** Hosts proxied by Cloudflare only accept a fixed list of ports.

#### Letting the monitor through Cloudflare Access

If `nas.yourdomain.com` is an Access application, the page will say *Cloudflare
Access is protecting Nextcloud*. Give the monitor its own key:

1. In the Cloudflare dashboard, go to *Zero Trust → Access controls → Service credentials → Service Tokens* and create a token called `nas-status`. Pick a duration you will remember to renew, or a non-expiring one. Copy the Client ID and Client Secret, because the secret is shown only once.
2. Go to *Zero Trust → Access controls → Applications*, edit the Nextcloud application and add a policy:
   - Action: **Service Auth**
   - Include: **Service Token** → `nas-status`
3. Store both values in the Worker and redeploy:
   ```bash
   npx wrangler secret put CF_ACCESS_CLIENT_ID
   npx wrangler secret put CF_ACCESS_CLIENT_SECRET
   npm run worker:deploy
   ```

Your own Access login policies stay as they are. Only requests carrying the token skip the login page.

Test from any machine outside your network:

```bash
curl -H "NC-Token: YOUR_TOKEN" \
  "https://cloud.yourdomain.com/ocs/v2.php/apps/serverinfo/api/v1/info?format=json"
```

You should get back JSON that starts with `{"ocs":{"meta":{"status":"ok"`.
Or let NAS Status check every step for you:

```bash
npm install
npm run check -- https://cloud.yourdomain.com YOUR_TOKEN
```

### 3. Configure and deploy

```bash
git clone https://github.com/Liam-burnett-AU/Nas-Status.git
cd Nas-Status
npm install
```

Edit the `vars` block in `wrangler.jsonc`. At minimum set `NEXTCLOUD_URL` and
`TIMEZONE`. Then log in, add your secrets and deploy:

```bash
npx wrangler login
npx wrangler secret put NEXTCLOUD_TOKEN
# Optional extras (disk volumes, server uptime, temperatures):
npx wrangler secret put NEXTCLOUD_USER
npx wrangler secret put NEXTCLOUD_APP_PASSWORD
npm run worker:deploy
```

Wrangler prints your `*.workers.dev` address. Monitoring starts the first time
anyone opens the page, or within five minutes through the cron watchdog. To use
your own domain, add one under *Workers & Pages → nas-status → Settings →
Domains & Routes*.

Useful commands:

```bash
npm run worker:tail     # live logs from the deployed Worker
npm run worker:dev      # run locally on http://localhost:8787 (put secrets in .dev.vars)
npm run check           # test the URL, token and app password from your own machine
```

### What it costs on the free plan

Static page requests are free and unlimited. Only `/api` calls and checks count.

| Workers Free limit (per day) | Used by NAS Status |
| --- | --- |
| 100,000 Worker requests | About 2,900 to 4,300 per browser tab left open all day |
| 100,000 Durable Object requests | 1,440 checks, plus the same per-tab figure as above |
| 100,000 rows written | About 5,800 (3 rows per check, plus 1 per alarm) |
| 13,000 GB-s of Durable Object time | Well under, because the object sleeps between checks |

The page asks for new data just after each check lands, and fetches chart history
only when a new check exists. A short per-location cache also lets several viewers
share one request.

> **Note:** the Durable Object is created in Oceania (`DO_LOCATION_HINT=oc`), so
> response times are measured from near Australia. Change the hint before the first
> deploy if your server is elsewhere. It only applies when the object is created.

## Monitoring your other apps

List them under `SERVICES` in `wrangler.jsonc`. They appear in the **Applications** section and count towards the overall status at the top.

```jsonc
"SERVICES": [
  { "name": "Logbook", "url": "https://logbook.lbdev.app", "access": true },
  { "name": "Login API", "url": "https://login.lbdev.app/health", "expectStatus": [200] },
  { "name": "Emailing API", "url": "" }
]
```

| Field | Meaning |
| --- | --- |
| `name` | What the page calls the app. |
| `url` | Address to check. Leave it `""` and the app shows as *Not set up* until you add one. |
| `access` | `true` sends the Cloudflare Access service token (`CF_ACCESS_*`) to this app. Add the same token to each app's Access policy. |
| `expectStatus` | Status codes that mean "up". By default, anything from 200 to 399 counts, including redirects to a login page. For an API, point `url` at a health endpoint, or list the codes its base address returns, for example `[200, 401, 404]`. |
| `keyword` | Text that must appear on the page, to catch an error page served with a 200. |
| `timeoutSeconds` / `slowMs` | Per-app overrides for the request timeout and the "slow" threshold. |

How an answer is judged:

- **Up:** an expected status code (and the keyword, if set) within the slow threshold.
- **Slow:** up, but slower than `slowMs` (default `RESPONSE_DEGRADED_MS`).
- **Down:** a timeout, a refused connection, a disconnected Cloudflare Tunnel, a Cloudflare 52x error, or an unexpected status code.
- **No data:** Cloudflare Access, bot protection or the firewall stopped the monitor before it reached the app. This says nothing about the app itself, so it is not counted as downtime. The page names the cause.

Up to 20 apps can be listed. Each check uses one request, which keeps well inside the free plan.

## Email alerts

NAS Status emails you through the Mail Relay Worker's `POST /api/send` endpoint:

- **A "down" email** after something fails 2 checks in a row, about 2 minutes. This is `INCIDENT_THRESHOLD`, which ignores one-off blips.
- **A "back up" email** after it passes 2 checks in a row, saying how long it was down. Set `ALERT_ON_RECOVERY` to `"false"` to skip these.
- **One email per check.** Several things going down at once arrive together.
- **No false alarms.** *No data* (for example a Cloudflare Access block) and maintenance never send an email.
- **Retries.** If the relay fails, the email is retried on the next checks, for up to 6 attempts within 24 hours.
- **A cap.** At most 20 emails go out per hour. The status page shows a banner if alerts are not getting through.

Set it up:

1. In `wrangler.jsonc`, set `ALERT_EMAIL_API_URL` to the relay's address, for example `https://mail.lbdev.app`. `/api/send` is added for you. Also set `STATUS_PAGE_URL` so the emails link to this page.
2. Add the two secrets:
   ```bash
   npx wrangler secret put ALERT_EMAIL_API_KEY   # the relay's SEND_EMAIL_API_KEY
   npx wrangler secret put ALERT_EMAIL_TO        # your address; separate several with commas (up to 10)
   npm run worker:deploy
   ```
3. Send yourself a test from your computer. Put the same three values in `.env`, then run:
   ```bash
   npm run alert:test
   ```

If the relay is a Worker on a **route** of the same zone, rather than a Custom Domain or `workers.dev`, Cloudflare blocks Worker-to-Worker `fetch()`. Uncomment the `MAIL_RELAY` Service Binding in `wrangler.jsonc` and put the relay Worker's name in it.

**Tip:** to watch the relay itself, add it to `SERVICES` as
`{ "name": "Emailing API", "url": "https://mail.lbdev.app/api/send", "expectStatus": [405] }`.
The endpoint only accepts POST, so a 405 answer means it is up.

## Alternative: run on your own server

Use this if you would rather not use Cloudflare. Steps 1 and the `curl` test above
still apply, but Nextcloud only needs to be reachable from the machine running
NAS Status.

```bash
cp .env.example .env
# edit .env: set NEXTCLOUD_URL, NEXTCLOUD_TOKEN and TIMEZONE

docker compose up -d --build      # Docker, or:
npm start                         # Node.js 18.17 or newer
# open http://localhost:8080
```

### Just want a look first?

```bash
npm run demo        # serves generated data on http://localhost:8080
```

You can also build a single, self-contained HTML snapshot of the demo:

```bash
npm run build:preview   # writes dist/preview.html (add -- --fragment for hosts that supply their own <html> wrapper)
```

Setting `DEMO_MODE` to `"true"` in `wrangler.jsonc` does the same on Workers.

## Configuration

On **Workers**, put settings in the `vars` block of `wrangler.jsonc`, and
secrets in with `npx wrangler secret put <NAME>`. On **Node.js**, use environment
variables or a `.env` file, where real environment variables take priority.
Invalid values are rejected with a clear message, which also appears on the page.

| Variable | Default | Description |
| --- | --- | --- |
| `NEXTCLOUD_URL` | — | **Required.** Base URL, including any sub-path such as `https://example.com/nextcloud`. |
| `NEXTCLOUD_TOKEN` | — | **Secret.** serverinfo token from step 1. Without it, only reachability is monitored. |
| `NEXTCLOUD_USER` / `NEXTCLOUD_APP_PASSWORD` | — | **Secret.** Optional admin **app password**. Unlocks disk volumes, server uptime and temperatures. |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | — | **Secret.** Cloudflare Access service token, if Nextcloud is protected by Access. |
| `SITE_TITLE` | `NAS Status` | Title shown in the header and browser tab. |
| `SITE_DESCRIPTION` | … | Meta description. |
| `TIMEZONE` | system zone | IANA zone such as `Australia/Brisbane`. Used for daily bars and every displayed time. |
| `SHOW_SERVER_DETAILS` | `true` | Show versions, PHP, database, caching and app details. Set `false` on a public page. |
| `POLL_INTERVAL_SECONDS` | `60` | How often to check, from 15 to 3600. |
| `REQUEST_TIMEOUT_SECONDS` | `10` | A request taking longer than this counts as unreachable. |
| `INCIDENT_THRESHOLD` | `2` | Consecutive bad checks needed to open an incident, and good checks needed to close it. |
| `RESPONSE_DEGRADED_MS` | `1500` | A `status.php` response slower than this counts as degraded. |
| `API_DEGRADED_MS` | `5000` | A serverinfo response slower than this counts as degraded. |
| `CPU_DEGRADED_PERCENT` | `90` | Load per thread, as a percentage, that counts as degraded. |
| `MEMORY_DEGRADED_PERCENT` | `90` | Memory use that counts as degraded. |
| `DISK_WARN_PERCENT` / `DISK_CRITICAL_PERCENT` | `85` / `95` | Volume use thresholds, used when the volume size is known. |
| `DISK_WARN_FREE_GB` / `DISK_CRITICAL_FREE_GB` | `50` / `10` | Free-space thresholds, used when only free space is known. |
| `DEMO_MODE` | `false` | Serve generated data instead of polling Nextcloud. |
| `DO_LOCATION_HINT` | `oc` | Workers only. Where the Durable Object is created: `oc`, `apac`, `wnam`, `enam`, `weur`, `eeur`, `sam`, `afr` or `me`. |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Node.js only. Listen address. |
| `DATA_DIR` | `./data` | Node.js only. Where `history.json` is stored. |
| `LOG_LEVEL` | `info` | Node.js only. `debug`, `info`, `warn` or `error`. |

> **Why an app password for the extras?** Upstream, `diskdata` and `basicdata`
> only accept a logged-in admin. They do not accept the `NC-Token`. Create a
> dedicated app password under *Personal settings → Security* so you can revoke
> it independently.

## How status is decided

| Component | Operational | Degraded | Partial outage | Major outage |
| --- | --- | --- | --- | --- |
| Web interface & file sync | `status.php` answers quickly | Slower than `RESPONSE_DEGRADED_MS` | — | Unreachable, timed out or not installed |
| Server API & database | serverinfo answers | Slow, or a database upgrade is pending | serverinfo errors while the web works | Server unreachable |
| Storage | Below the warning level | At or above the warning level | At or above the critical level | — |
| CPU & memory | Below the thresholds | CPU or memory over its threshold | — | — |

The following rules apply on top of the table:

- **Maintenance mode** in `status.php` shows *Under maintenance*. Those checks are left out of uptime.
- **A rejected token** shows the API as *No data*, not as an outage, because it is a monitor configuration problem.
- **Uptime** counts operational and degraded checks as up, and partial or major outages as down.
- **Back-off.** Nextcloud's brute-force protection throttles IP addresses that keep sending bad credentials. After a rejection, authenticated calls back off exponentially, up to 30 minutes, while `status.php` keeps being checked on schedule.

## JSON API

| Endpoint | Description |
| --- | --- |
| `GET /api/status` | Current status, components with 90-day daily series, availability, metrics, details and incidents. |
| `GET /api/history?range=1h\|6h\|24h\|7d` | Bucketed time series for the charts. |
| `GET /healthz` | Returns `200` while checks complete on schedule and `503` if the monitor has stalled. It reports on the monitor, not on Nextcloud. |

Every field in `/api/status` is explicitly whitelisted. Tokens, passwords, PHP-FPM
request URIs and PHP extension names are never exposed.

## Deploying behind a reverse proxy

This section applies to the Node.js version.

## Deploying behind a reverse proxy

The page uses relative URLs, so it works at a sub-path such as
`https://example.com/status/`. Here is an nginx example:

```nginx
location /status/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Here is a systemd unit if you are not using Docker:

```ini
[Unit]
Description=NAS Status
After=network-online.target

[Service]
WorkingDirectory=/opt/nas-status
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=nas-status
EnvironmentFile=/opt/nas-status/.env

[Install]
WantedBy=multi-user.target
```

## Security notes

- **The token stays server-side.** On Workers it is an encrypted secret. The browser only sees the sanitised `/api/status` output.
- **Exposing versions can help attackers.** Set `SHOW_SERVER_DETAILS=false` before publishing the page to the internet.
- **Strict response headers.** The page sends a Content Security Policy, `nosniff`, `no-referrer` and frame protection. On Workers these come from `public/_headers` and the Worker itself. On Node.js, static file paths are also protected against directory traversal.
- **The container runs as a non-root user.**

## Troubleshooting

| Message | Fix |
| --- | --- |
| *Nextcloud rejected the monitoring token* | The token does not match. Read it with `occ config:app:get serverinfo token`, confirm it with `npm run check`, then run `npx wrangler secret put NEXTCLOUD_TOKEN` again and paste it. Leading or trailing spaces and quotes are removed automatically. A corrected token is tried straight away. |
| *Nextcloud rejected the app password* | The account in `NEXTCLOUD_USER` must be an admin, and the app password must be the generated one (Personal settings → Security), not your login password. |
| `Response was not JSON - this host is not in Nextcloud's trusted_domains` | Add the host name you use in `NEXTCLOUD_URL` to `trusted_domains` in `config.php`. |
| `Unexpected redirect` | Check `http` versus `https` and the sub-path in `NEXTCLOUD_URL`. |
| `TLS certificate not trusted` | On Node.js, self-signed certificates need `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. On Workers, use a publicly trusted certificate, which a Cloudflare Tunnel provides. TLS verification is never disabled. |
| *Cloudflare Access is protecting Nextcloud* | Add a service token as described in step 2. |
| *Cloudflare's bot protection challenged the monitor* | Turn off Bot Fight Mode for the domain under *Security → Bots*. |
| *The Cloudflare Tunnel for … is not connected (error 1033)* | Start `cloudflared` on the NAS, and check the tunnel's status in Zero Trust under *Networks → Tunnels*. |
| *Something in front of Nextcloud refused the request* | Access, a firewall rule or a reverse proxy blocked the monitor before Nextcloud saw it. `status.php` never needs a login. These checks show as *No data*, not downtime. |
| *Something in front of the status page blocked the data request (HTTP 403)* | Cloudflare security, Cloudflare Access or a web filter blocked `/api/status`. The status page never sends a 403. Look up the Ray ID shown on the page under *Security → Events*. If Access protects the site, the page and `/api/*` need the same policy. |
| *Cloudflare security challenged the data request* | Bot Fight Mode, "I'm Under Attack" mode or a WAF rule challenged `/api/*`. Turn Bot Fight Mode off, or add a WAF custom rule for this host and path `/api/` with the action *Skip*. |
| Console: `beacon.min.js` violates the Content Security Policy | Cloudflare Web Analytics injects this script. Current versions allow it, so redeploy. |
| `NEXTCLOUD_URL must use a host name` | Workers cannot fetch IP addresses. Add a DNS record or a Cloudflare Tunnel and use that name. |
| Everything shows *Unreachable* on Workers | Nextcloud is not reachable from the internet. Run the `curl` test from step 2 on a phone using mobile data. |
| Token works with `npm run check` but is rejected on Workers | The Worker is probably using a different value. Run `npx wrangler secret list` to confirm `NEXTCLOUD_TOKEN` exists on this Worker, put it again, and watch `npm run worker:tail`. The log shows the token's length (64 for an `openssl rand -hex 32` token) but never the token. |
| `Response is not an OCS envelope` | Enable the app with `occ app:enable serverinfo`. |
| Free storage shows *size unknown* | Add the admin app password so the data volume can be matched from `diskdata`. |

## Development

```bash
npm test               # 74 tests: normaliser, evaluator, app checks, email alerts, history store, Durable Object storage, client, check script, and end-to-end against a mock Nextcloud
npm run worker:dev     # the Worker on the real Workers runtime, locally
npm run demo           # Node.js preview with generated data
npm run build:preview  # single-file HTML snapshot in dist/
```

```
src/worker.mjs       Cloudflare Worker entry and the StatusMonitor Durable Object (alarms, cron watchdog)
src/durable-storage.mjs  history persistence in Durable Object storage, chunked by hour
wrangler.jsonc       Workers configuration (assets, Durable Object, cron, vars)
server.js            Node.js host: HTTP server, static files, timer loop, shutdown
lib/routes.js        API routing and security headers shared by both hosts
lib/config.js        environment parsing and validation
lib/persist-file.js  history persistence for Node.js (atomic JSON file)
lib/nextcloud.js     API client (timeouts, auth, helpful errors)
lib/normalise.js     raw serverinfo payload to a clean snapshot (units, -1 and false sentinels)
lib/evaluate.js      component and overall status rules
lib/store.js         history, uptime maths, incidents, persistence
lib/monitor.js       one monitoring round, with auth back-off
lib/services.js      checks for the other apps in SERVICES
lib/alerts.js        down/back-up emails through the Mail Relay
lib/api.js           whitelisted public payload
lib/demo.js          realistic generated data in serverinfo's own format
public/              the page (HTML, CSS, dependency-free SVG charts)
```

Built by Liam Burnett · LB Dev. MIT licence.
