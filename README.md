# devops-k8s-pipeline

A production-grade Kubernetes deployment pipeline for a Node.js REST API, multi-stage Docker builds, Sealed Secrets, RBAC, NetworkPolicy, HPA, Helm, Prometheus/Grafana observability, and a GitHub Actions CI/CD pipeline with vulnerability scanning, all deployed and verified together on a live cluster.

## Architecture

> Rendered as Mermaid rather than a static PNG, GitHub renders it natively, and it stays in sync with the repo instead of going stale as a binary asset.

```mermaid
flowchart LR
    Dev[Developer] -->|git push| GH[GitHub Repo]
    GH --> CI[GitHub Actions: build-push-deploy.yaml]
    CI -->|docker build| Image[Docker Image]
    CI -->|trivy scan --exit-code 1| Scan{Trivy Gate}
    Scan -->|pass| GHCR[(GHCR Registry - SHA tagged)]
    Scan -->|fail| Block[Pipeline blocked]
    CI -->|helm upgrade --install| Cluster

    subgraph Cluster[Kubernetes Cluster - namespace: app]
        Ingress[Ingress] --> Svc[Service - ClusterIP, named port http]
        Svc --> Pod[Pod: REST API]
        HPA[HPA - min/max tiered by env, cpu target] -.scales.-> Pod
        SA[ServiceAccount] -.attached.-> Pod
        Role[Role - least privilege] --> RB[RoleBinding] --> SA
        SealedSecret[SealedSecret] -->|decrypted by controller| Secret[Secret] --> Pod
        NetPol[NetworkPolicy - default deny + allow from ingress-nginx] -.protects.-> Pod
        CM[ConfigMap] --> Pod
        SM[ServiceMonitor] -.scrapes /metrics.-> Pod
    end

    subgraph Monitoring[monitoring namespace]
        Prom[Prometheus] -->|scrape via SM| SM
        Prom --> Graf[Grafana]
    end

    GHCR -->|image pull| Pod
    User[External User] --> Ingress
```

## Repository Structure

```
devops-k8s-pipeline/
├── src/                          # Node.js REST API source
│   ├── index.js
│   ├── index.test.js
│   └── metrics.js                # prom-client instrumentation (counter + histogram)
├── Dockerfile                    # Multi-stage, non-root build
├── k8s/                          # Raw Kubernetes manifests
│   ├── namespace.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── configmap.yaml
│   ├── hpa.yaml
│   ├── ingress.yaml
│   ├── networkpolicy.yaml
│   ├── serviceaccount.yaml
│   ├── role.yaml
│   ├── rolebinding.yaml
│   └── sealedsecret.yaml
├── helm/
│   └── app-chart/
│       ├── Chart.yaml
│       ├── values.yaml           # defaults / production-tier documentation
│       ├── values-dev.yaml       # dev overrides (lighter HPA + resource bounds)
│       ├── values-prod.yaml      # prod overrides (heavier HPA + resource bounds)
│       └── templates/
│           ├── namespace.yaml
│           ├── deployment.yaml
│           ├── service.yaml
│           ├── configmap.yaml
│           ├── hpa.yaml
│           ├── ingress.yaml
│           ├── networkpolicy.yaml
│           ├── serviceaccount.yaml
│           ├── role.yaml
│           ├── rolebinding.yaml
│           ├── servicemonitor.yaml   # Prometheus scrape target
│           └── _helpers.tpl
├── .github/
│   ├── workflows/
│   │   └── build-push-deploy.yaml
│   └── dependabot.yml
└── docs/
    └── screenshots/
```

## Kubernetes Manifests

| File | Purpose | Key detail |
|---|---|---|
| `namespace.yaml` | Isolates all app resources in the `app` namespace | Also templated in the Helm chart, see [Helm Chart](#helm-chart) for the namespace-adoption pattern this requires |
| `deployment.yaml` | Runs the REST API pods | Rolling update strategy: `maxSurge: 1`, `maxUnavailable: 0`, zero downtime during rollouts; requests/limits set so the scheduler and HPA can both function |
| `service.yaml` | Stable internal DNS + load balancing to pods | `ClusterIP`, internal only, exposed externally via Ingress; port is explicitly **named** (`http`) so the `ServiceMonitor` can target it |
| `configmap.yaml` | Non-secret app configuration | Consumed via `envFrom` |
| `hpa.yaml` | Autoscaling | Bounds and CPU target are tiered per environment, see [HPA & metrics-server](#hpa--metrics-server) |
| `ingress.yaml` | External HTTP routing into the cluster | Routes to the `service.yaml` ClusterIP |
| `networkpolicy.yaml` | Restricts which traffic can reach the pod | Default-deny ingress, explicit allow only from the `ingress-nginx` namespace via `namespaceSelector` |
| `serviceaccount.yaml` | Dedicated pod identity | Named, not `default`, `automountServiceAccountToken: false` since the app never calls the Kubernetes API |
| `role.yaml` / `rolebinding.yaml` | Least-privilege RBAC | Scoped to the `app` namespace only |
| `sealedsecret.yaml` | Encrypted credential delivery | Safe to commit, decrypted only by the in-cluster Sealed Secrets controller |
| `servicemonitor.yaml` | Tells Prometheus what to scrape | Selector must match the Service's own labels exactly; targets the Service's named `http` port, not a raw port number |

## Security Design

- No static credentials anywhere in CI, GHCR push uses `GITHUB_TOKEN`, a token GitHub generates and scopes automatically per workflow run, not a long-lived PAT.
- Containers run as a non-root user.
- Secrets are never committed in plaintext, only Sealed Secrets ciphertext.
- Default-deny NetworkPolicy, every pod is isolated unless explicitly allowed.
- Dedicated ServiceAccount per app, least-privilege Role, no reliance on the `default` ServiceAccount.
- Every image is scanned for HIGH/CRITICAL CVEs before it can be deployed, the pipeline fails closed, not open.

## Sealed Secrets Workflow

Why: a Kubernetes `Secret` is base64-encoded, not encrypted, anyone with `kubectl get secret -o yaml` or repo access can decode it in one command. Sealed Secrets solves this by encrypting the Secret client-side, so only the in-cluster controller (holding the private key) can decrypt it.

```bash
# 1. Create the plain secret ONLY in /tmp, never in the repo
kubectl create secret generic app-secret \
  --from-literal=DB_PASSWORD='<value>' \
  --dry-run=client -o yaml > /tmp/secret.yaml

# 2. Seal it using the controller's public key
kubeseal --format=yaml < /tmp/secret.yaml > k8s/sealedsecret.yaml

# 3. Delete the plaintext file immediately
rm /tmp/secret.yaml

# 4. Commit only the sealed (encrypted) version
git add k8s/sealedsecret.yaml
git commit -m "feat: add Sealed Secrets"
git push

# 5. Verify the plaintext secret never touched git history
git log --all --full-history -- k8s/secret.yaml
# → returns nothing
```

The `SealedSecret` object is safe in a public repo: without the controller's private key (which never leaves the cluster), the ciphertext is useless. On apply, the controller decrypts it into a normal Kubernetes `Secret` inside the cluster only.

## RBAC

- `serviceaccount.yaml`, a named ServiceAccount, not the namespace's `default` one.
- `role.yaml`, the absolute minimum verbs the app needs. This app doesn't call the Kubernetes API at all (config arrives via `envFrom`/mounted volumes), so the Role is intentionally close to empty, a deliberate design decision, not an oversight.
- `rolebinding.yaml`, scoped to the `app` namespace, capping the Role's reach even if it were broader.
- `automountServiceAccountToken: false` on the pod spec, since the app has no legitimate reason to talk to the API server, it doesn't get a credential capable of doing so, which closes off a lateral-movement path if the container is ever compromised.

## HPA & metrics-server

HPA needs real CPU metrics to scale, and those metrics come from `metrics-server`, not from Kubernetes itself. On minikube, `metrics-server` doesn't work out of the box because it can't verify the kubelet's self-signed TLS certificate, this shows up as `kubectl describe hpa` reporting `<unknown>` instead of a percentage.

```bash
minikube addons enable metrics-server

kubectl patch deployment metrics-server -n kube-system --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

kubectl rollout status deployment/metrics-server -n kube-system
```

One real gotcha hit while building this: re-running the patch command more than once (while debugging an unrelated issue) appended `--kubelet-insecure-tls` to the args array four times over, since a JSON-patch `add` operation always appends rather than checking for an existing value. Cleaned up with a single `op: replace` supplying the full, deduplicated args array in one shot, `add` and `replace` are not interchangeable for idempotent patching.

**Bounds are tiered per environment**, not fixed. `values.yaml` documents the production design (min 2 / max 5, 70% CPU target); `values-dev.yaml` overrides to a lighter min 1 / max 2 to fit a resource-constrained local minikube VM; `values-prod.yaml` overrides to min 3 / max 10 at a 60% target. A `kubectl get hpa` on a local dev deploy correctly shows the dev-tier bounds, not the production ones documented at the top level, this is intentional environment-scoping, not drift between the docs and the cluster.

Verified end state:

```bash
kubectl describe hpa -n app
# → cpu: <real number>%/<target>% (real number, not <unknown>)

curl localhost:3000/health
# → {"status":"ok"}
```

## Helm Chart

```
helm/app-chart/
├── Chart.yaml
├── values.yaml           # defaults
├── values-dev.yaml       # dev overrides only
├── values-prod.yaml      # prod overrides only
└── templates/
    ├── namespace.yaml
    ├── deployment.yaml
    ├── service.yaml
    ├── configmap.yaml
    ├── hpa.yaml
    ├── ingress.yaml
    ├── networkpolicy.yaml
    ├── serviceaccount.yaml
    ├── role.yaml
    ├── rolebinding.yaml
    ├── servicemonitor.yaml
    └── _helpers.tpl
```

`helm lint` clean, `helm template` produces valid YAML for every manifest.

**Namespace adoption pattern (real issue, not theoretical):** this chart templates its own `Namespace` resource. On a fresh cluster, `helm install` can fail with `Error: INSTALLATION FAILED: create: failed to create: namespaces "app" not found`, even though the chart is completely valid. This isn't a chart bug; it's a race between Helm creating the Namespace and the API server finishing registration before Helm's very next resource-creation call in the same release. `--create-namespace` is not a safe workaround here, it creates an untracked namespace that then collides with the chart's own templated one.

Fix:

```bash
kubectl create namespace app

kubectl label namespace app app.kubernetes.io/managed-by=Helm
kubectl annotate namespace app \
  meta.helm.sh/release-name=app \
  meta.helm.sh/release-namespace=app

helm install app ./helm/app-chart -f helm/app-chart/values-dev.yaml
```

Stamping the namespace with Helm's exact ownership metadata makes Helm adopt the existing namespace instead of trying (and failing) to create it fresh.

*Backlog: convert this into a Helm `pre-install` hook so future clean-cluster installs don't need the manual pre-create step. Not implemented yet, the manual fix is well understood and this is new material beyond the original Helm curriculum.*

**ServiceMonitor wiring:** a `ServiceMonitor`'s `selector.matchLabels` must match the target `Service`'s labels exactly, and its `endpoints[].port` refers to a **named** Service port (`name: http`), not a bare port number, a Service with an unnamed port gives the ServiceMonitor nothing to resolve, even with a perfectly correct selector. Confirmed working via Prometheus's own target list (`serviceMonitor/app/api/0`, state `UP`).

## CI/CD Pipeline

`.github/workflows/build-push-deploy.yaml`, two jobs, two different triggers:

**`build`**, runs automatically on every push to `main`:

1. Checkout code
2. Log in to GHCR using `GITHUB_TOKEN`, a token GitHub auto-generates per workflow run, scoped by the `permissions:` block (`packages: write` here), and never stored as a long-lived secret. No PAT, no static credential.
3. Build the Docker image
4. **Trivy scan**, pipeline fails closed if HIGH/CRITICAL CVEs are found (see below)
5. Push the image to GHCR tagged with `${{ github.sha }}` (the full 40-character commit SHA), never `latest`

**`deploy`**, runs only on manual `workflow_dispatch`, never automatically on push:

6. Configure kubeconfig from a `KUBE_CONFIG_DATA` secret
7. Pre-create and Helm-adopt the target namespace (see the [Helm Chart](#helm-chart) namespace-adoption pattern)
8. `helm upgrade --install ... --set image.tag=${{ github.sha }}`

**Why deploy is gated, not automatic:** GitHub-hosted runners have no reachable Kubernetes cluster by default. A `deploy` job wired into the same trigger as `build` would fail on every single push, not intermittently, structurally, since there's nothing for `helm upgrade` to connect to. Rather than leave a job in the pipeline that can never succeed as designed, `deploy` only runs on an explicit `workflow_dispatch`, against a cluster whose kubeconfig is supplied as a secret. This also mirrors how most real deploy pipelines work: build/test/scan on every commit, deploy behind an explicit gate, not blind auto-deploy on every merge.

**Why SHA tags, not `latest`:** every image is traceable to the exact commit that produced it, and a rollback is just redeploying a known-good SHA, no ambiguity about what `latest` currently points to. The tag is the **full** SHA (`${{ github.sha }}`), not the short 7-character form `git log --format=%h` prints, a manual local deploy has to use the full SHA or it will fail with `manifest unknown` against a tag that was never actually pushed. The tradeoff: `values.yaml`'s dev default of `image.tag: latest` is intentional for local development, but since the pipeline only ever publishes SHA tags, a bare `helm install` without an explicit `--set image.tag=<full-sha>` override will fail. That's expected behavior, not a bug, see [Local Deployment](#local-deployment-minikube).

## Vulnerability Scanning (Trivy)

```yaml
- name: Scan image for vulnerabilities
  run: |
    docker run --rm aquasec/trivy image \
      --exit-code 1 \
      --severity HIGH,CRITICAL \
      ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
```

`--exit-code 1` means the pipeline fails the build if any HIGH or CRITICAL CVE is found, vulnerabilities block the release rather than being logged and ignored.

Real findings from the first scan: **13 HIGH vulnerabilities.**

- **2** in Alpine OS packages (`libcrypto3`, `libssl3`), fixed with `apk update && apk upgrade --no-cache` in the runtime stage.
- **11** traced to the npm CLI's own bundled dependency tree, not anything in this project's `package.json`. Since the container's `CMD` calls `node` directly and never invokes `npm`/`npx` at runtime, those binaries (and their vulnerable dependencies) were removed from the runtime image entirely rather than chasing unfixable upstream overrides.

Re-scan after the fix: **0 HIGH/CRITICAL.**

## Dependency Updates (Dependabot)

`.github/dependabot.yml` watches two ecosystems on a weekly schedule: `npm` (application dependencies) and `github-actions` (workflow action versions), kept as separate entries since they're different ecosystems with different update cadences and risk profiles.

## Observability (Prometheus + Grafana)

`kube-prometheus-stack` installed via Helm into a separate `monitoring` namespace, configured to watch every `ServiceMonitor` cluster-wide (`serviceMonitorSelectorNilUsesHelmValues=false`) rather than only ones labeled for its own release, since the app's `ServiceMonitor` lives in a different namespace under different labels.

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

### App instrumentation

`src/metrics.js` uses `prom-client` to expose two custom metrics plus Node's default process metrics, all served from a `/metrics` endpoint:

- `http_requests_total` — a Counter, labeled by `method`, `route`, `status_code`. Powers request-rate queries via `rate()`.
- `http_request_duration_seconds` — a Histogram with latency buckets, powers percentile queries via `histogram_quantile()`.
- `collectDefaultMetrics()` — free process-level CPU/memory/event-loop metrics, no extra code needed.

Both custom metrics are recorded inside a `res.on('finish', ...)` handler, not before calling `next()`, `finish` only fires once the response is actually sent, so `res.statusCode` reflects the real final status even if a downstream handler changes it. Recording earlier would mislabel every request as its initial status code.

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api
  namespace: {{ .Values.namespace }}
spec:
  selector:
    matchLabels:
      app: api
  namespaceSelector:
    matchNames:
      - {{ .Values.namespace }}
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
```

**Gotcha:** `endpoints[].port: http` refers to a Service port by **name**, not by number, the Service manifest needed an explicit `name: http` added to its port definition before this could resolve to anything, even with a correct label selector. Verified in Prometheus's own target list: `serviceMonitor/app/api/0`, state `UP`, real scrapes every 15s.

### Dashboards

- **Cluster-level:** no custom dashboards built, `kube-prometheus-stack`'s Grafana sidecar ships the full `kubernetes-mixin` and `node-exporter-mixin` dashboard sets by default (`Compute Resources / Cluster`, `/ Namespace (Pods)`, `/ Pod`, `/ Node (Pods)`, `Node Exporter / Nodes`, etc.). Confirmed showing real, live CPU/memory numbers against the actual running `api` pod, these are the "community dashboards" the observability design called for, pre-wired rather than manually imported.
- **App-level:** a custom "App Metrics" dashboard with two panels, built against the custom metrics above:
  - Request rate by route: `sum(rate(http_requests_total[5m])) by (route)`
  - p95 latency by route: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))`

Screenshots: [`docs/screenshots/`](docs/screenshots)

## Local Deployment (Minikube)

```bash
minikube start
minikube addons enable ingress
minikube addons enable metrics-server

kubectl patch deployment metrics-server -n kube-system --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl rollout status deployment/metrics-server -n kube-system

# Pre-create + adopt the namespace (see Helm Chart section above)
kubectl create namespace app
kubectl label namespace app app.kubernetes.io/managed-by=Helm
kubectl annotate namespace app \
  meta.helm.sh/release-name=app \
  meta.helm.sh/release-namespace=app

# Deploy with the actual published SHA tag, "latest" was never published
helm install app ./helm/app-chart \
  -f helm/app-chart/values-dev.yaml \
  --set image.tag=<actual-full-sha-from-ghcr>

# Observability stack (see Observability section above)
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

Verify:

```bash
kubectl get pods -n app
# → Running 1/1

kubectl describe hpa -n app
# → cpu: <real>%/<target>%

curl localhost:3000/health
# → {"status":"ok"}

curl localhost:3000/metrics | grep http_requests_total
# → real counter lines, not empty
```

Screenshots of the verified deployment: [`docs/screenshots/`](docs/screenshots)

## What I Learned

- **Layer cache order matters more than it looks.** Copying `package*.json` before the rest of the source (before `npm ci`) means Docker only reinstalls dependencies when they actually change, not on every single source edit.
- **NetworkPolicy is additive, not exclusive.** The moment any policy selects a pod, all unlisted traffic is denied by default, multiple policies stack their allow-rules rather than overriding each other, which is easy to get backwards under pressure.
- **A syntactically valid Helm chart can still fail on a fresh cluster.** The namespace-registration race between Helm's Namespace creation and its next resource call isn't a chart bug, it's an API-server timing issue, and the fix (pre-create + ownership-annotation adoption) is a pattern worth reusing on any chart that templates its own Namespace.
- **SHA tags vs `latest` is a deliberate tradeoff, not a default to "fix."** The instinct when `manifest unknown` shows up is to make `latest` exist. The correct fix was the opposite: keep the SHA-only publishing design for traceability, and make the deploy command specify the tag explicitly and specifically the **full** SHA, since `${{ github.sha }}` in Actions never matches the short 7-character form.
- **A commit that was never actually pushed produces the exact same symptom as a tag-format mismatch.** Chased `manifest unknown` down two different wrong paths (short vs full SHA) before checking `git log -1 --oneline` against `origin/main` and discovering the real commit had simply never reached the remote. The lesson: verify the commit is actually on GitHub before debugging the deploy command at all.
- **Vulnerability scanning the built image catches things `npm audit` never will.** 11 of 13 HIGH findings were in the npm CLI's own bundled dependencies, completely invisible to `npm audit`, which only looks at `package.json`'s tree, and they were unused at runtime entirely, so the real fix was removing the binary, not patching it.
- **`kubectl patch` with `op: add` is not idempotent.** Re-running the same JSON-patch add operation multiple times appends duplicate array entries instead of no-op'ing, `op: replace` with the full desired array is the safe way to apply the same patch more than once.
- **A CI job that can never succeed in its runner environment is worse than no job at all.** The `deploy` job was originally wired to run on every push despite GitHub-hosted runners having no reachable cluster, guaranteed to fail every single time, for reasons that had nothing to do with the code being deployed. Gating it behind `workflow_dispatch` turned a permanently-red job into an accurate signal: automatic CI now reports what's actually true (build, scan, and push all succeed), and deploy is a deliberate, on-demand action instead of a job destined to fail by design.
- **A ServiceMonitor's selector and port reference are both silent failure points.** A label mismatch or an unnamed Service port doesn't throw an error anywhere, Prometheus just never lists the target at all. Confirming a real `UP` state in Prometheus's own target list is the only reliable verification, not just "the YAML applied cleanly."
- **HPA bounds should be environment-tiered, not fixed.** What looked like a documentation/reality mismatch (2/5 documented vs 1/2 observed) was actually correct: production-tier bounds live in the base `values.yaml`, and `values-dev.yaml` intentionally overrides to lighter bounds for a resource-constrained local cluster. Worth stating explicitly in docs so it reads as design, not drift.

## Tech Stack

Node.js · Express · Docker · Kubernetes · Helm · Sealed Secrets · RBAC · NetworkPolicy · HPA · Prometheus · Grafana · prom-client · GitHub Actions · Trivy · Dependabot · minikube

## License

MIT
