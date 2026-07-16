# Privát Chat App

Buildelhető, privát 1:1 chat alkalmazás React + Node.js + Socket.IO + SQLite alapon.

## Mit tud most?

- Regisztráció és belépés JWT tokennel
- Jelszó hash-elés bcrypttel
- Valós idejű privát üzenetek Socket.IO-val
- Online/offline állapot
- SQLite alapú helyi adattárolás
- Külön frontend és backend, de rootból is indítható

## Első telepítés

```bash
npm install
npm run install:all
copy server\.env.example server\.env
copy client\.env.example client\.env
```

A `server\.env` fájlban cseréld le a `JWT_SECRET` értékét egy hosszú, véletlen titokra.

## Fejlesztés

Root mappából:

```bash
npm run dev
```

Ez egyszerre indítja:

- Backend: `http://localhost:4000`
- Frontend: `http://localhost:5173`

Backend teszt:

```txt
http://localhost:4000/health
```

Sikeres válasz:

```json
{"ok":true}
```

## Build

```bash
npm run build
```

A frontend build a `client/dist` mappába kerül.

## Telefonos használat

Fejlesztés közben telefonról is megnyitható, ha a backend és frontend ugyanazon a hálózaton fut, és a `.env` címeket a gép helyi IP-címére állítod.

PWA-ként iPhone-on:

1. Nyisd meg Safariban az app HTTPS-es címét.
2. Share gomb.
3. Add to Home Screen.

Natív iOS `.ipa` buildhez macOS, Xcode és Apple Developer aláírás kell. Windowsról a web/PWA build készíthető el, az iOS aláírás nem.

## Élesítés előtt fontos

- Használj erős `JWT_SECRET` értéket.
- Csak HTTPS mögött tedd ki internetre.
- Állítsd be a `CLIENT_URL`, `VITE_API_URL` és `VITE_SOCKET_URL` értékeket a végleges domainre.
- A `server/chat.db` tartalmazza a felhasználókat és üzeneteket, ezért ne töltsd fel publikus helyre.
- Az üzenetek kliensoldali AES-GCM titkosítással mennek fel. A közös beszélgetéskulcsot csak a résztvevők ismerjék.

## Mappák

```txt
private-chat-app/
  client/   React + Vite frontend
  server/   Express + Socket.IO + SQLite backend
```
