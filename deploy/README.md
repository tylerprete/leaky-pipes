# Deploying the game server

One small VM runs two containers: the game server and Caddy, which handles HTTPS. These steps are written for an Oracle Cloud Ampere A1 (Arm) instance on a pay-as-you-go account, kept inside the free allowance. They work on any Linux VM with Docker. This setup has not been run on Oracle yet, so treat the Oracle-specific steps as a checklist to verify.

## 1. Create the instance

- Shape `VM.Standard.A1.Flex`, 1 OCPU and 6 GB memory (well inside the free allowance), Ubuntu image, default 47 GB boot volume.
- Give it a public IPv4 address and add your SSH key.
- Set a budget alert (Billing > Budgets) at about $1 so anything billable shows up as an email.

## 2. Open ports 80 and 443 (two places)

1. Oracle network: in the instance's subnet, add ingress rules to the security list (or a network security group) for TCP 80 and TCP 443 from `0.0.0.0/0`.
2. The instance's own firewall. Oracle's Ubuntu images ship with iptables rules that block everything but SSH:

   ```
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

   On Oracle Linux use `sudo firewall-cmd --permanent --add-service=http --add-service=https && sudo firewall-cmd --reload`.

## 3. Point a domain at it

Create an A record (for example `pipes.yourdomain.com`) to the instance's public IP. Caddy needs this to get a certificate, and browsers need HTTPS before a page can open a `wss://` connection.

## 4. Install Docker and start

```
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/tylerprete/leaky-pipes.git
cd leaky-pipes/deploy
cp .env.example .env        # edit: DOMAIN=pipes.yourdomain.com
docker compose up -d --build
```

Check it: `curl https://pipes.yourdomain.com/health` should print `{"ok":true,"rooms":0}`. Then open `https://pipes.yourdomain.com/` and use Play online.

## 5. Make the GitHub Pages copy offer online play (optional)

The server already serves the game at its own address. To have the Pages site use it too, rebuild on your machine with the address baked in and push:

```
LEAKY_SERVER=wss://pipes.yourdomain.com npm run build
git commit -am "Point the page at the game server" && git push
```

## Updating

```
cd leaky-pipes && git pull && cd deploy && docker compose up -d --build
```

Restarting ends any games in progress (they live in memory).

## Notes

- Run one instance only; rooms are not shared between servers.
- Logs: `docker compose logs -f app`.
- The server allows 500 rooms and drops rooms after two quiet hours. Change with `MAX_ROOMS` in the compose file.
