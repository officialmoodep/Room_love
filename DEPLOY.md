# راهنمای دیپلوی (بدون فیلترشکن)

Firebase به‌عنوان دیتابیس یدک باقی مونده؛ سرور خودت اصلیه.
سایت رو باید از آدرس همون هاست باز کنی (نه Vercel).

## راه ۱: لیارا (Liara)
1. تو لیارا یه اپ از نوع Node.js بساز؛ یه دیسک به اسم `data` رو مسیر `/data` وصل کن.
2. متغیر محیطی `DATA_FILE=/data/db.json` رو بذار.
3. روی کامپیوترت:
       npm i -g @liara/cli
       liara login
       liara deploy
4. آدرس `https://اسم-اپ.liara.run` رو باز کن. (HTTPS خودکار داره و WebSocket رو ساپورت می‌کنه.)

## راه ۲: VPS (اوبونتو)
    apt update && apt install -y nodejs npm caddy
    mkdir -p /opt/love-room && cd /opt/love-room   # فایل‌ها رو اینجا کپی کن
    npm install --omit=dev
    cp love-room.service /etc/systemd/system/
    systemctl enable --now love-room
    # دامنه رو تو Caddyfile بذار و:
    cp Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
دامنه باید A-record به IP سرور داشته باشه تا Caddy خودش گواهی HTTPS بگیره.

## تماس تصویری (TURN)
بدون TURN ممکنه تماس بین بعضی اینترنت‌ها وصل نشه. روی VPS:
    apt install -y coturn
    # /etc/turnserver.conf:
    #   listening-port=3478
    #   fingerprint
    #   lt-cred-mech
    #   realm=your-domain.ir
    #   user=u:p
    systemctl enable --now coturn
بعد متغیر محیطی سرور:
    ICE_SERVERS=[{"urls":"turn:IP:3478","username":"u","credential":"p"}]
