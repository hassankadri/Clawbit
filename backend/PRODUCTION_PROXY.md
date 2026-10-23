
# Clawbit production HTTPS and trusted proxies

## Purpose

Clawbit requires HTTPS when `CLAWBIT_AUTH_MODE=production`.

If nginx, a load balancer, or another trusted proxy terminates
TLS, the backend may receive ordinary HTTP from that proxy.

The backend must receive the correct forwarded scheme from the
trusted proxy without accepting spoofed headers from arbitrary
clients.

## Production startup

Use `production_server.py` rather than the ordinary local
development Uvicorn command when deploying behind a proxy.

Configure these environment variables:

- `CLAWBIT_AUTH_MODE=production`
- `CLAWBIT_ALLOWED_ORIGINS` — the exact HTTPS frontend origin
- `CLAWBIT_TRUSTED_PROXIES` — the IP addresses or CIDR networks
  of the reverse proxies that connect directly to Uvicorn

Optional configuration:

- `CLAWBIT_BACKEND_BIND_HOST` — defaults to `127.0.0.1`
- `CLAWBIT_BACKEND_PORT` — defaults to `8000`

To start the backend from its directory:

```powershell
.\.venv\Scripts\python.exe production_server.py
```

This enables Uvicorn's proxy-header handling with an explicit
allowlist. Local development remains unchanged.

## Example: nginx on the same computer

For nginx connecting locally to Uvicorn:

```text
CLAWBIT_TRUSTED_PROXIES=127.0.0.1
```

Keep Uvicorn bound to `127.0.0.1` so external clients cannot
connect directly to its port.

At the nginx HTTPS reverse-proxy location, set:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;

proxy_pass http://127.0.0.1:8000;
```

The nginx virtual host must have working TLS certificates and
redirect plaintext HTTP requests to HTTPS.

The proxy must replace incoming forwarded headers with
authenticated values. Do not forward arbitrary client-supplied
`X-Forwarded-Proto` values.

## Example: external load balancer

Use only the addresses or CIDR networks of the infrastructure
that connects directly to the backend.

Restrict backend network access to those proxies using a
firewall, security group, or private network.

Never use:

```text
CLAWBIT_TRUSTED_PROXIES=*
```

Do not trust all IP addresses or arbitrary client-supplied
forwarding headers.

The proxy must terminate HTTPS correctly before forwarding
the HTTPS scheme to Uvicorn.

## Security boundaries

The production launcher validates configuration before
opening the server's listening socket.

Only trusted peers can influence Uvicorn's forwarded request
scheme and forwarded client address.

The existing application-level HTTPS check remains enabled.
An ordinary HTTP request or an untrusted spoofed HTTPS header
still results in HTTP 403.

A forwarded HTTPS header is an assertion from the trusted
reverse proxy. It does not independently prove that TLS was
used by the original browser. The trusted proxy must enforce
TLS and sanitize forwarding headers.

Keep the backend port inaccessible to untrusted networks.
Preserve Clawbit's exact allowed origins, secure session
cookies, CSRF checks and authentication controls.

## Existing local installation

Do not switch the existing local installation to production
mode merely to run the offline test suite.

Continue using the ordinary development command locally.
No owner reinitialization, database reset, connector credentials,
or real network access is required for the proxy tests.
