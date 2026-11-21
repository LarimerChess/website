FROM python:3.13-slim
WORKDIR /app
RUN pip install --no-cache-dir 'gunicorn>=23,<27'
COPY scripts/sync_stripe_payments.py scripts/stripe_webhook.py ./
CMD ["sh", "-c", "exec gunicorn --bind :${PORT:-8080} --workers 2 --timeout 90 stripe_webhook:app"]
