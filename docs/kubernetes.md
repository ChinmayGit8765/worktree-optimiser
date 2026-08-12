# Kubernetes backend (planned)

> **Status: not implemented.** This documents the intended migration path and the design
> decisions already made to keep it cheap. Nothing here runs today.

## Why it's a small change

`docker.ts` is the only module that knows containers exist. Everything else — git
operations, detection, the registry, the API surface, the dashboard — deals in
`ProjectConfig` and `WorktreeInfo` and would be untouched.

The Traefik label model was chosen partly because it maps onto Ingress almost
one-to-one. A worktree is already described as: an image, a command, a mount, a port, and
a hostname rule. That is a Deployment plus a Service plus an Ingress.

## Mapping

| Docker today | Kubernetes equivalent |
| --- | --- |
| Container `wt-<project>-<slug>` | Deployment (`replicas: 1`) in namespace `wt-<project>` |
| Traefik container labels | Ingress rule, host `<slug>.<domain>` |
| `wt-net` bridge network | Namespace + Service |
| Named volume for `node_modules` | PersistentVolumeClaim per worktree |
| Bind mount of the worktree | **The hard part — see below** |
| `docker logs --follow` | `GET /api/v1/namespaces/…/pods/…/log?follow=true` |
| Labels as source of truth | Labels/annotations on the Deployment |

The label keys carry over verbatim (`wt.project`, `wt.branch`, `wt.slug`, …), so the
"no database, re-derive state from the orchestrator" property survives.

## The hard part: getting source into the pod

A bind mount is trivial locally and has no clean cluster equivalent. Three options, in
increasing order of how much they change the product:

### 1. hostPath (local clusters only)

Docker Desktop's Kubernetes, kind, minikube and k3d can all mount host directories. This
preserves the current model exactly — edit on the host, the pod sees it — and works for
the local-dev use case that motivates this tool.

Limitation: single-node only. Fine for Docker Desktop, useless for a shared cluster.

### 2. Sync sidecar

A sidecar container running `mutagen` or `syncthing` replicates the worktree into an
emptyDir the app container also mounts. Works on real clusters and preserves the
edit-locally feel, at the cost of a sync daemon per pod and a class of "why is the pod
stale" bugs.

### 3. Clone in an init container

An init container does `git clone --branch <branch> --depth 1` into an emptyDir. Simple,
robust, cluster-native — and changes the product: the pod runs *the branch*, not *your
working copy*. Edits require a commit and a pod restart.

This is the right model for a shared review environment ("run every open PR"), and the
wrong one for local development. Both are legitimate; they're different products sharing
a control plane.

**Likely resolution:** hostPath for local clusters, init-container clone for remote ones,
selected per project. The API surface doesn't change either way.

## Sketch

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wt-my-app-feature-new-header
  namespace: wt-my-app
  labels:
    wt.managed: "true"
    wt.project: my-app
    wt.slug: feature-new-header
    wt.branch: feature/new-header     # sanitised; real name in an annotation
spec:
  replicas: 1
  selector:
    matchLabels: { wt.slug: feature-new-header }
  template:
    spec:
      containers:
        - name: dev
          image: node:22-bookworm-slim
          command: ["sh", "-lc"]
          args: ["set -e; npm install; exec npm run dev -- --host 0.0.0.0 --port 5173"]
          workingDir: /workspace
          ports: [{ containerPort: 5173 }]
          env:
            - { name: HOST, value: "0.0.0.0" }
            - { name: CHOKIDAR_USEPOLLING, value: "true" }
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
            - { name: node-modules, mountPath: /workspace/node_modules }
      volumes:
        - name: workspace
          hostPath: { path: /run/desktop/mnt/host/c/dev/my-app-worktrees/feature-new-header }
        - name: node-modules
          persistentVolumeClaim: { claimName: wt-my-app-feature-new-header-nm }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: wt-my-app-feature-new-header
  namespace: wt-my-app
spec:
  ingressClassName: traefik
  rules:
    - host: feature-new-header.localhost
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: wt-my-app-feature-new-header
                port: { number: 5173 }
```

Note the label-value constraint: `wt.branch: feature/new-header` is **not** a valid label
value (slashes are disallowed). The real branch name has to live in an annotation, with
the slug in the label. Docker labels have no such restriction, so this is a genuine
difference to handle rather than a mechanical port.

## Work required

1. Extract an `Orchestrator` interface from `docker.ts` — roughly `ensureProxy`, `up`,
   `stop`, `restart`, `remove`, `list`, `logs`, `followLogs`, `probe`.
2. Implement `kubernetes.ts` against `@kubernetes/client-node`.
3. Select the backend per project (`orchestrator: "docker" | "kubernetes"`), defaulting
   to docker.
4. Handle the label-value constraint and namespace-per-project lifecycle.
5. Replace `docker logs` streaming with the pod log endpoint — it's already an async
   line stream behind the same SSE route, so the API doesn't change.

Steps 1 and 5 are worth doing regardless: the interface makes `docker.ts` testable, and
nothing else in the codebase should ever import dockerode.
