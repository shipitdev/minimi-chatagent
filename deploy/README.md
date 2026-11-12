# Ubuntu service deployment

The competition endpoint runs on an Ubuntu 24.04 x86_64 VM. Cloudflare Tunnel connects the existing public hostname to a loopback HTTPS gateway. DSH stays on another loopback port. The Mac is no longer required to keep the demo running.

## Processes and files

| Component | Location / responsibility |
| --- | --- |
| Application | `/opt/minichat/app` |
| Dedicated account | `minichat`, system account without an interactive shell |
| Scoped Node 24.11.0 | `/opt/minichat/runtime/node-v24.11.0-linux-x64` |
| Scoped connector | `/opt/minichat/bin/cloudflared` |
| Backend and gateway | `minichat.service`, ports 8789 and 8788 on 127.0.0.1 |
| Tunnel | `minichat-tunnel.service`, outbound connector; no new public app port |
| Trace exporter | `minichat-traces.service`, project `minimi-live-azure` |
| Application memory | `data/minimi.db` |
| DSH state | `data/server-dsh` |
| Runtime credentials | `.env` and `data/private/`, excluded from Git |

[serve.mjs](../scripts/serve.mjs) supervises DSH and the gateway, captures the private entry URL into a mode-600 file, redacts launch tokens from stdout, and exits if either child fails. systemd restarts the process group and enables startup at boot. The tunnel and exporter have separate restart policies.

The service uses a scoped PATH; it does not replace system Node/npm or affect unrelated VM services. The unit templates assume the paths above. Install the app and eval dependencies using the scoped Node PATH, with `npm_config_cache=/opt/minichat/app/data/npm-cache` when running as `minichat`.

## Provisioning contract

1. Install the pinned Linux Node archive under the scoped runtime path, checking its SHA-256 against the official release manifest. Install cloudflared under the scoped bin directory.
2. Create the `minichat` system user and copy application source. Run root and eval `npm ci` as that user. App files must be writable by it because startup builds the host plugin and patches the checked client strings.
3. Create a mode-700 `data/private` directory. Supply the provider/LangSmith keys in mode-600 `.env`; provision the tunnel token, origin certificate and private key there. None belong in the repository.
4. Set these non-secret deployment variables in `.env`:

```dotenv
MINIMI_PUBLIC_URL=https://minimi.sparetokens.tech
MINIMI_TLS_CERT=/opt/minichat/app/data/private/origin-cert.pem
MINIMI_TLS_KEY=/opt/minichat/app/data/private/origin-key.pem
MINIMI_NO_OPEN=1
MINIMI_DEBUG=0
LANGSMITH_LIVE_PROJECT=minimi-live-azure
```

5. Install the three unit files in `/etc/systemd/system/`. Precreate `data/service.log`, `data/tunnel.log`, and `data/traces.log` as `minichat`, mode 600. Install [rotation settings](minichat.logrotate) in `/etc/logrotate.d/minichat`.
6. Configure the tunnel ingress for HTTPS localhost:8788, `originServerName=localhost`, and the VM's origin-certificate CA path. Enable the services after verifying the origin.

The public gateway retains the existing shared-profile behavior and optional access-key configuration. It is not a multi-user authorization boundary.

## Operations

```sh
sudo systemctl status minichat minichat-tunnel minichat-traces
sudo systemctl restart minichat
sudo systemctl is-enabled minichat minichat-tunnel minichat-traces
sudo logrotate --debug /etc/logrotate.d/minichat
```

Service, tunnel and exporter text logs rotate daily or above 10 MB, retain seven rotations, and are compressed. JSON turn traces remain separate; this rotation policy does not impose retention on the SQLite memory or individual trace files.

Use loopback TLS verification and the private entry-file readiness check together; the static gateway health response alone does not prove model readiness. Do not print the private entry file. A new unauthenticated browser should enter through the public gateway.

The transferred origin certificate expires **2027-02-09**. Renew it before then, retaining localhost SAN coverage, the configured trust path and secure file modes; restart backend and connector to load the replacement. Automatic certificate renewal is not configured.

## Verification and clean state

On Ubuntu: root/eval dependency installs completed; 25/25 offline tests passed. A deliberate backend process kill recovered under systemd. The public URL passed live arithmetic, Search/Fetch with clickable Node.js sources, and memory recall in a new browser session after a service restart. Boot enablement was checked; the VM was not rebooted because it hosts unrelated workloads.

After acceptance, test conversations, SQLite state and operational logs were moved into a private VM backup and the live state was restarted clean. The prior Mac state was privately backed up and its supervisor stopped. Saved repository evaluations and hosted historical evaluation traces were not deleted. Azure live traces use a new project to keep deployment monitoring separate.

For rollback, stop the VM connector, restore the Mac supervisor/state if needed, and restore the tunnel's Mac CA path before starting the Mac connector. Avoid serving the same hostname from connectors with different state/configuration during a rollback.

The services survive process failure and start at VM boot; they cannot keep the app available if Azure shuts down/deallocates the VM or its network is unavailable. Availability is not guaranteed by a service restart policy.
