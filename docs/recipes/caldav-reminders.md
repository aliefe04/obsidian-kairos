# Reminders on an iPhone, through a CalDAV server

This is the path that puts a reminder into the iPhone's own **Reminders** app —
so the phone alarms at the due minute with Kairos closed — without a Mac in the
loop and without our code touching Apple's services.

Two facts decide the whole design:

- **iCloud's own CalDAV does not carry Reminders.** (2Do's documentation is
  explicit: "Reminders does not read or write CalDAV task lists".) A CalDAV
  account you run yourself *is* surfaced there, though: Nextcloud's Tasks app
  lists "Apple Reminders (iOS, MacOS)" as a supported client, and iOS itself has
  the account type for it.
- **The account must be reachable from the phone.** A server on your LAN works
  at home and nowhere else. If the phone leaves the network, a reminder written
  while away cannot be registered until it comes back. See *Reachability* below.

## What Kairos writes

Each reminder becomes one `VTODO` in a collection you name, with an absolute
`VALARM` at the due instant. The resource name is derived from the instance id
(`kairos-<instanceId>.ics`), which is what makes an edited due time an update in
place rather than a second task that fires on the old time as well, and lets a
cancelled reminder be deleted from the instance id alone.

Verified against a real Radicale (locally, 2026-09-11): `PUT` into a collection
that does not exist answers `409`, so the channel creates the collection with
`MKCALENDAR` and retries once; the second `PUT` of a moved due time answers `204`
and leaves **one** resource; `DELETE` by the derived URL removes it.

## The server

Radicale: a single Python process, no database, disk-backed. The container below
keeps one named volume and no more.

```yaml
# docker-compose.yml — the light footprint: one service, one volume, no database
services:
  radicale:
    image: tomsquest/docker-radicale:3
    container_name: radicale
    restart: unless-stopped
    ports:
      - "127.0.0.1:5232:5232"   # behind a TLS proxy; see Reachability
    volumes:
      - radicale-data:/data
      - ./radicale/config:/config/config:ro
      - ./radicale/users:/data/users:ro
    mem_limit: 64m
    security_opt:
      - no-new-privileges:true

volumes:
  radicale-data:
```

```ini
# radicale/config
[server]
hosts = 0.0.0.0:5232
max_connections = 20

[auth]
type = htpasswd
htpasswd_filename = /data/users
# bcrypt, not plain: this file is the only thing between the internet and the
# user's tasks, and `plain` is for throwaway test servers only.
htpasswd_encryption = bcrypt

[storage]
type = multifilesystem
filesystem_folder = /data/collections

[rights]
type = owner_only
```

Create the account — the only step that needs a shell, and the only one whose
secret should not be typed into a chat window:

```sh
docker run --rm -v "$PWD/radicale/users:/data/users" --entrypoint sh tomsquest/docker-radicale:3 \
  -c 'htpasswd -B -c /data/users kairos'   # prompts for the password
docker compose up -d
```

The collection does **not** have to be created by hand: the channel creates it on
the first reminder. With `rights = owner_only` the collection URL is
`<base>/<user>/<collection>/`, so for the login `kairos` and the collection
`kairos`:

```
https://kairos.example.com/kairos/kairos/
```

Paste that into **Settings → Kairos → CalDAV collection URL**, with the user and
password below it.

## Reachability

iOS's CalDAV account setup assumes TLS. A plain `http://…:5232/…` endpoint is
reachable in practice only if you turn off *Use SSL* in the account's advanced
settings, which is fiddly and easy to get wrong. Prefer a name iOS already
trusts:

- **On a tailnet**: `tailscale serve --bg 5232` gives the machine a
  `https://<host>.<tailnet>.ts.net/` name with a certificate iOS accepts, and the
  phone reaches it from anywhere it has the tailnet up.
- **On a VPS with a domain**: a Caddy or nginx reverse proxy in front of
  `127.0.0.1:5232` with a Let's Encrypt certificate.
- **LAN only**: bind to the LAN address and accept that reminders written away
  from home are registered when the phone comes back.

Whichever you pick, the collection URL the channel is given must be the URL the
**phone** will use. If the plugin registers through `127.0.0.1` and the phone
holds a different address, the two are still the same account only if the server
is the same one — so use one URL everywhere.

## The iPhone

1. **Settings → Reminders → Reminders Accounts → Add Account → Other → Add
   CalDAV Account.**
2. Server: the base URL (no collection path). User name and password as created
   above.
3. When asked which apps to use the account with, tick **Reminders**.
4. Open Reminders: the collection appears as a list, and tasks written by Kairos
   arrive in it.

## What is verified, and what still needs the phone

| Link | Evidence |
| --- | --- |
| Write, update in place, delete against a real CalDAV server | Verified locally against Radicale, container log and `PROPFIND` listing: one resource after a due-time move, `404` after the delete |
| A collection that does not exist yet | Verified: `MKCALENDAR` then retry, against an empty server |
| Third-party CalDAV lists appear in iOS Reminders | Documented by Nextcloud Tasks (client list) and by iOS's account type; not measured here |
| **A `VTODO` with a `VALARM` actually alarms on iOS** | **Not verified.** No one involved can measure it from outside an iPhone. Treat the alarm as unconfirmed until a reminder written on the Mac rings on the phone at its due minute (`docs/risks.md`, R15) |
| Registration ahead of time, withdrawal on completion | Engine-level, covered by `tests/schedule.perChannelPush.test.ts`: `deleteAfterDue` is what removes a task whose due time has passed |

The cheap way to settle the last line: write `- [ ] test 5 minutes from now
09:00` into a dated note, let Kairos register it, close Obsidian, and wait. If the
phone stays silent, the alarm is the part to question — not the sync, which the
list itself proves.
