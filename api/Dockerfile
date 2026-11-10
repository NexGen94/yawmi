# yawmi-api image. Build context: api/  (docker build -t yawmi-api api)
#
# Stage 1 resolves the locked dependencies into /opt/venv with uv; stage 2 copies only that
# virtualenv, so the final image carries no compiler, no uv and no sources. Runs as uid 10001,
# which is the owner the secrets loader gives /run/yawmi/yawmi_api_pw.

FROM python:3.13.18-slim AS build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

RUN pip install uv==0.12.15

WORKDIR /app

# Dependencies first: this layer is rebuilt only when pyproject.toml or uv.lock change.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-editable --no-install-project

COPY yawmi ./yawmi
RUN uv sync --frozen --no-dev --no-editable


FROM python:3.13.18-slim

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN groupadd --system --gid 10001 yawmi \
    && useradd --system --uid 10001 --gid yawmi --no-create-home --shell /usr/sbin/nologin yawmi

COPY --from=build /opt/venv /opt/venv
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/yawmi-entrypoint

USER 10001:10001
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/v1/health/live', timeout=3)"]

# The entrypoint builds YAWMI_DATABASE_URL from the secrets volume and then runs its arguments,
# so `docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin pair-code ...` works too.
# --no-access-log: the app writes its own access line without query strings (uvicorn's would not).
ENTRYPOINT ["/usr/local/bin/yawmi-entrypoint"]
CMD ["uvicorn", "yawmi.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
