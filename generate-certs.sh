#!/bin/bash
# ============================================================
# Generate self-signed SSL certificates for testing
# Run this on the server before enabling HTTPS in nginx.conf
# ============================================================
#
# For production, use Let's Encrypt instead:
#   certbot certonly --standalone -d yourdomain.com -d org1.yourdomain.com -d org2.yourdomain.com

set -e

CERTS_DIR="./certs"
DOMAIN="${1:-localhost}"

mkdir -p "$CERTS_DIR"

echo "Generating self-signed certificate for *.$DOMAIN ..."

openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout "$CERTS_DIR/privkey.pem" \
  -out "$CERTS_DIR/fullchain.pem" \
  -subj "/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN,DNS:*.$DOMAIN"

echo ""
echo "✅ Certificates created in $CERTS_DIR/"
echo "   - $CERTS_DIR/fullchain.pem"
echo "   - $CERTS_DIR/privkey.pem"
echo ""
echo "Next steps:"
echo "  1. Uncomment the HTTPS server blocks in nginx/nginx.conf.template"
echo "  2. Uncomment the certs volume mount in docker-compose.yml"
echo "  3. Run: docker compose restart nginx"
