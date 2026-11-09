FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

RUN useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin app && mkdir -p /mnt/system && chown app:app /mnt/system

WORKDIR /app

COPY requirements.txt ./

RUN pip install -r requirements.txt

COPY . .

USER app

EXPOSE 8001

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/healthz', timeout=3).status == 200 else 1)"

CMD ["python", "main.py"]
