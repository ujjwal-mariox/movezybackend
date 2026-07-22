# Movezy backend — EC2 deployment

Node 22 · Express 5 · MongoDB · Redis · Socket.io. Build is `tsc` → `dist/`,
entrypoint `dist/server.js`.

## Hard requirements

The process **refuses to boot** without these — `src/config/index.ts` throws on
any missing value:

| Variable | Notes |
|---|---|
| `DB_URL` | MongoDB connection string |
| `REDIS_URL` | Not optional. Socket.io's adapter and the route/fare cache both need it |
| `JWTSECRET` | Generate fresh — never reuse the dev value |
| `REGION` `BUCKET` `ACCESSKEY` `SECRETACCESSKEY` | S3, for KYC and profile uploads |

In `NODE_ENV=production` the boot preflight additionally **fails** if
`CORS_ORIGIN` is unset or `*`, and **warns** about a missing `OSRM_URL`,
Razorpay keys, or Firebase config.

## Steps

1. **Instance** — Ubuntu 24.04, t3.small or larger (t3.micro OOMs during `tsc`),
   20 GB gp3. Inbound 22 (your IP), 80, 443 only. Elastic IP + DNS A record.

2. **Runtime**

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs nginx redis-server git
   sudo systemctl enable --now redis-server
   sudo npm install -g pm2
   ```

3. **Code + deps** — clone to `/var/www/movezy`, then `npm ci` in `backend/`.

4. **`.env`** — see the table above plus Razorpay / Firebase / Twilio / SMTP as
   needed. `chmod 600 .env`. Generate the secret with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

5. **Build** — `npm run build`

6. **Seed (first deploy only)** — `npx ts-node src/seeds/index.ts`, then change
   the seeded admin password immediately.

7. **Run** — `pm2 start dist/server.js --name movezy-api --time`, then
   `pm2 save && pm2 startup systemd`.

8. **nginx** — reverse proxy to `127.0.0.1:$PORT`. The WebSocket upgrade headers
   are mandatory; Socket.io shares the API port and silently degrades to polling
   without them.

   ```nginx
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   client_max_body_size 25M;   # KYC uploads
   ```

9. **TLS** — `sudo certbot --nginx -d api.yourdomain.com`.

10. **Verify** — `GET /health` and `GET /v1/api/home`, then confirm a Socket.io
    handshake upgrades rather than long-polls.

## Proxy hops

`app.set("trust proxy", 1)` is set in `server.ts`. Behind one nginx it is
correct. Add a layer (CloudFront → ALB → nginx) and raise it via
`TRUST_PROXY_HOPS`, or the IP-keyed rate limiters will bucket all traffic
together.

## Routing (affects fares)

Distance is priced from real road routes. `OSRM_URL` defaults to the **public
demo server**, which is fair-use only and will rate-limit production traffic —
quotes then silently degrade to a straight-line approximation. Self-host OSRM
(or use a paid provider) and set `OSRM_URL` before real traffic.

## Client builds

Both Flutter apps resolve their backend at build time:

```
flutter build apk --dart-define=API_ORIGIN=https://api.yourdomain.com
```

Production is the **default**, so a plain `flutter build apk` is safe. For local
work against a tethered device:

```
flutter run --dart-define=API_ORIGIN=http://127.0.0.1:9050
```

(with `adb reverse tcp:9050 tcp:9050`).

## Still to do before real traffic

- Self-host OSRM (see above).
- Mongo backups — Atlas continuous backup, or `mongodump` on a cron.
- Log rotation for PM2: `pm2 install pm2-logrotate`.
- Rotate the seeded admin credentials and any keys that have been in the repo.
