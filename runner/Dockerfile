FROM python:3.13-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap util-linux gcc g++ make libc6-dev libseccomp2 \
 && rm -rf /var/lib/apt/lists/*

COPY seccomp_gen.c /tmp/seccomp_gen.c
RUN apt-get update && apt-get install -y --no-install-recommends libseccomp-dev \
 && gcc -O2 -Wall -o /tmp/seccomp_gen /tmp/seccomp_gen.c -lseccomp \
 && mkdir -p /opt/runner && /tmp/seccomp_gen /opt/runner/seccomp.bpf \
 && apt-get purge -y --auto-remove libseccomp-dev && rm -rf /tmp/seccomp_gen* /var/lib/apt/lists/*

COPY runner.py sandbox.py tools.json /opt/runner/

RUN groupadd -g 10001 runner && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin runner \
 && mkdir -p /run/runner && chown 10001:10001 /run/runner && chmod -R a+rX /opt/runner
USER 10001:10001

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 RUNNER_PORT=8002 USERS_ROOT=/mnt/system/users
EXPOSE 8002
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD python3 -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('RUNNER_PORT','8002')+'/v1/health',timeout=2)"

CMD ["python3", "/opt/runner/runner.py"]
