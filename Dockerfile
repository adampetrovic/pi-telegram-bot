# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ARG TARGETARCH=amd64
ARG PI_CODING_AGENT_VERSION=0.70.5
ARG JJ_VERSION=0.38.0
ARG KUBECTL_VERSION=v1.35.1
ARG FLUX_VERSION=2.7.5
ARG SOPS_VERSION=3.11.0
ARG TASK_VERSION=3.48.0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        gh \
        jq \
        openssh-client \
        procps \
        python3 \
        python3-pip \
        python3-venv \
        tini \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN npm install -g "@mariozechner/pi-coding-agent@${PI_CODING_AGENT_VERSION}"

RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) jj_arch="x86_64"; sops_arch="amd64"; task_arch="amd64" ;; \
        arm64) jj_arch="aarch64"; sops_arch="arm64"; task_arch="arm64" ;; \
        *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/jj.tgz" "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-${jj_arch}-unknown-linux-musl.tar.gz"; \
    tar -xzf "${tmp}/jj.tgz" -C "${tmp}"; \
    install -m 0755 "${tmp}/jj" /usr/local/bin/jj; \
    curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
    chmod +x /usr/local/bin/kubectl; \
    curl -fsSL -o "${tmp}/flux.tgz" "https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/flux_${FLUX_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    tar -xzf "${tmp}/flux.tgz" -C "${tmp}"; \
    install -m 0755 "${tmp}/flux" /usr/local/bin/flux; \
    curl -fsSL -o /usr/local/bin/sops "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${sops_arch}"; \
    chmod +x /usr/local/bin/sops; \
    curl -fsSL -o "${tmp}/task.tgz" "https://github.com/go-task/task/releases/download/v${TASK_VERSION}/task_linux_${task_arch}.tar.gz"; \
    tar -xzf "${tmp}/task.tgz" -C "${tmp}"; \
    install -m 0755 "${tmp}/task" /usr/local/bin/task; \
    rm -rf "${tmp}"

RUN groupadd --gid 568 pi \
    && useradd --uid 568 --gid 568 --create-home --home-dir /config --shell /bin/bash pi \
    && install -d -o pi -g pi /config/.pi/agent /config/pi-telegram-bot /config/code /config/.local/share/pi-telegram-bot/sessions

WORKDIR /opt/pi-telegram-bot
COPY --from=build --chown=pi:pi /app/package.json /app/package-lock.json ./
COPY --from=build --chown=pi:pi /app/node_modules ./node_modules
COPY --from=build --chown=pi:pi /app/dist ./dist
COPY --chown=pi:pi bin ./bin
COPY --chown=pi:pi config.example.yaml README.md ./
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/pi-telegram-bot-entrypoint

ENV HOME=/config \
    PI_BIN=pi \
    PI_CODING_AGENT_DIR=/config/.pi/agent \
    PI_TELEGRAM_BOT_CONFIG=/config/pi-telegram-bot/config.yaml \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    PATH=/opt/pi-telegram-bot/bin:/usr/local/bin:/usr/bin:/bin

USER 568:568
WORKDIR /config
ENTRYPOINT ["tini", "--", "pi-telegram-bot-entrypoint"]
CMD ["node", "/opt/pi-telegram-bot/dist/index.js"]
