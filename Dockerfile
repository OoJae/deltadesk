# DeltaDesk core service: API + data pipeline + tape recorder.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/app/.venv UV_PYTHON_DOWNLOADS=never PYTHONUNBUFFERED=1
COPY engine/pyproject.toml engine/uv.lock engine/.python-version engine/
RUN cd engine && uv sync --frozen --no-dev --no-install-project
COPY engine engine
COPY recorder recorder
COPY scripts scripts
EXPOSE 8787
CMD ["sh", "scripts/start.sh"]
