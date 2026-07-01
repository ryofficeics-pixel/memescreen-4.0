# MemeScreener 4.0 — Deployment Guide

## Local → Online in 5 minutes (ngrok)

The fastest way to get a public URL without any server:

```bash
# 1. Install ngrok
winget install ngrok

# 2. Sign up at ngrok.com (free), get your authtoken
ngrok config add-authtoken YOUR_AUTHTOKEN

# 3. Expose port 3002
ngrok http 3002
```

You'll see:
```
Forwarding  https://abc123def456.ngrok-free.app -> http://localhost:3002
```

Share that URL. Works while your PC is running.

**Limitations:** URL changes on every restart (paid plan fixes this), only works while PC is on.

---

## VPS Deployment (Hetzner — recommended)

### 1. Get a VPS

**Hetzner CX22** — €4.35/mo, 2 vCPU, 4GB RAM, 40GB SSD
- Go to hetzner.com → Cloud → New Project → Add Server
- Select: Ubuntu 24.04, CX22, any datacenter
- Add your SSH key or use a password
- Note the IP address

### 2. Connect and set up

```bash
ssh root@YOUR_VPS_IP

# Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt install -y nodejs git nginx certbot python3-certbot-nginx

# Install PM2
npm install -g pm2
```

### 3. Deploy the app

```bash
# Clone your repo
git clone https://github.com/YOU/memescreener-4.0.git
cd memescreener-4.0

# Create .env
cp .env.example .env
nano .env
# Fill in:
#   QUICKNODE_RPC_URL=...
#   TELEGRAM_BOT_TOKEN=...
#   TELEGRAM_CHAT_ID=...
#   PORT=3002

# Install and build
npm install
npm run build

# Start with PM2
pm2 start dist/src/index.js --name memescreener
pm2 save
pm2 startup   # run the command it prints
```

### 4. Verify it's running

```bash
pm2 status
pm2 logs memescreener --lines 20
curl http://localhost:3002/api/health
```

### 5. Point a domain (optional)

At your domain registrar, add an **A record**:
```
Type: A
Name: screener  (or @)
Value: YOUR_VPS_IP
TTL: 300
```

### 6. Set up HTTPS with nginx

```bash
# Create nginx config
cat > /etc/nginx/sites-available/memescreener << 'EOF'
server {
    listen 80;
    server_name screener.yourdomain.com;

    location / {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
EOF

ln -s /etc/nginx/sites-available/memescreener /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Get SSL cert
certbot --nginx -d screener.yourdomain.com
```

Your dashboard is now at **https://screener.yourdomain.com** 🎉

### 7. Updates

```bash
cd memescreener-4.0
git pull
npm install
npm run build
pm2 restart memescreener
```

---

## PM2 cheatsheet

```bash
pm2 status                    # show all processes
pm2 logs memescreener         # live logs
pm2 logs memescreener --lines 100   # last 100 lines
pm2 restart memescreener      # restart
pm2 stop memescreener         # stop
pm2 delete memescreener       # remove from PM2
pm2 monit                     # CPU/RAM monitor
```

---

## Firewall setup

```bash
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw enable
```

Don't open port 3002 directly — nginx proxies it.

---

## Docker deployment

```bash
# Build
docker build -t memescreener .

# Run with persistent data volume
docker run -d \
  --name memescreener \
  --restart unless-stopped \
  -p 3002:3002 \
  --env-file .env \
  -v /opt/memescreener/data:/app/data \
  memescreener
```

---

## Environment variables for production

Update these in `.env` for production:

```env
NODE_ENV=production
LOG_LEVEL=warn         # less verbose than info
PORT=3002

# Tighter scan interval when server never sleeps
SCAN_INTERVAL_MINUTES=15

# You can lower thresholds slightly with a fast RPC
MIN_LIQUIDITY_USD=40000
```
