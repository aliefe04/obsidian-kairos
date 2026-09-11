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
(`kairos-<instanceId>.ics`) rather than minted, which makes a repeated write
rewrite the same task — a pass that cannot tell whether its predecessor landed
does not leave two behind — and lets a cancelled reminder be deleted from the
instance id alone, even if no handle was ever stored.

Changing the time in the note is a different instance: the id is derived from the
time as well as the line, so Kairos withdraws the old task by the id it stored and
writes the new one. The phone ends up with one task, at the new time.

Verified against a real Radicale (locally, 2026-09-11): `PUT` into a collection
that does not exist answers `409`, so the channel creates the collection with
`MKCALENDAR` and retries once; the second `PUT` of a moved due time answers `204`
and leaves **one** resource; `DELETE` by the derived URL removes it.

## The server

Radicale: a single Python process, no database, disk-backed. The container below
keeps one named volume and no more.

```yaml
# /opt/radicale/docker-compose.yml — the light footprint: one service, one volume, no database
services:
  radicale:
    image: tomsquest/docker-radicale:latest   # there is no `:3` tag; pinned by digest where it matters
    container_name: radicale
    restart: unless-stopped
    ports:
      - "5232:5232"           # reachable from the LAN; see Reachability for TLS
    volumes:
      - ./collections:/data/collections
      - ./users:/data/users
      - ./config.toml:/config/config:ro
    mem_limit: 96m
    security_opt:
      - no-new-privileges:true
```

```ini
# /opt/radicale/config.toml
[server]
hosts = 0.0.0.0:5232
max_connections = 20

[auth]
type = htpasswd
htpasswd_filename = /data/users
# bcrypt, not plain: this file is the only thing between the network and the
# user's tasks, and `plain` is for throwaway test servers only.
htpasswd_encryption = bcrypt

[storage]
type = multifilesystem
filesystem_folder = /data/collections

[rights]
type = owner_only
```

The image ships neither `htpasswd` nor `bcrypt` on the default `python3` — the
hash has to be made with the virtualenv Radicale itself runs under, which is also
the library that will verify it:

```sh
cd /opt/radicale
PASS=$(openssl rand -base64 36 | tr -d '/+=' | head -c 28)
docker run --rm --entrypoint /venv/bin/python tomsquest/docker-radicale:latest \
  -c 'import bcrypt,sys;print(bcrypt.hashpw(sys.argv[1].encode(),bcrypt.gensalt(rounds=12)).decode())' \
  "$PASS" > /tmp/hash
printf 'kairos:%s\n' "$(cat /tmp/hash)" > users && rm /tmp/hash
printf '%s\n' "$PASS" > .caldav-password
chmod 600 users .caldav-password      # readable by root only; it is the only copy
docker compose up -d
```

`GET /<user>/` answers **403** until the user's first collection exists. That is
not a misconfiguration: with `rights = owner_only` there is nothing to read yet,
and the channel creates the collection itself with `MKCALENDAR` on the first
reminder.

The collection does **not** have to be created by hand: the channel creates it on
the first reminder. With `rights = owner_only` the collection URL is
`<base>/<user>/<collection>/`, so for the login `kairos` and the collection
`kairos`:

```
https://kairos.example.com/kairos/kairos/
```

Paste that into **Settings → Kairos → CalDAV collection URL**, with the user and
password below it.

## The deployment this was verified against

Installed 2026-09-11 on the Debian 12 box (`192.168.3.56`), beside the other
stacks under `/opt`:

| | |
| --- | --- |
| Path | `/opt/radicale/` (`docker-compose.yml`, `config.toml`, `users`, `collections/`, `.caldav-password`) |
| Image | `tomsquest/docker-radicale:latest`, digest `sha256:0f1b45abed8b…` |
| Ports | `0.0.0.0:5232` |
| Password | `/opt/radicale/.caldav-password` (mode 600, root only) — read it there and type it into the phone; it appears nowhere else |
| Collection URL | `http://192.168.3.56:5232/kairos/kairos/` — created ahead of time with an authenticated `MKCALENDAR` (`201`, then `PROPFIND` `207`), so the list is visible in Reminders as soon as the account is added, without waiting for a first reminder |

Verified over the network from another machine with the channel's own code (not
`curl`): the collection was created on the first write, a Turkish title survived
escaping and folding, moving the due time left exactly one resource, and the
delete returned the task to `404`. The account used for that run was removed
afterwards; only `kairos` remains.

Note the server already runs a `cloudflared` tunnel for other services. Publishing
this collection through it would give the phone an HTTPS name iOS trusts, which is
the cleanest answer to the TLS point below — but that is a change to a running
tunnel, so it is left for a deliberate decision rather than done quietly.

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
| Write, update in place, delete against a real CalDAV server | Verified locally against Radicale, container log and `PROPFIND` listing: a second write of the same instance left one resource, `404` after the delete |
| A collection that does not exist yet | Verified: `MKCALENDAR` then retry, against an empty server |
| Third-party CalDAV lists appear in iOS Reminders | Documented by Nextcloud Tasks (client list) and by iOS's account type; not measured here |
| **A `VTODO` with a `VALARM` actually alarms on iOS** | **Not verified.** No one involved can measure it from outside an iPhone. Treat the alarm as unconfirmed until a reminder written on the Mac rings on the phone at its due minute (`docs/risks.md`, R15) |
| The channel against the deployed server, over the network | Verified from another machine with the plugin's own code: bootstrap, Turkish title folded and escaped, one resource after a due-time move, `404` after the delete. The account it authenticated with was created with **bcrypt** (`$2b$12$`) by the one-liner above, so that path is exercised, not just written down |
| Registration ahead of time, withdrawal on completion | Engine-level, covered by `tests/schedule.perChannelPush.test.ts`: `deleteAfterDue` is what removes a task whose due time has passed |

The cheap way to settle the last line: write `- [ ] test 5 minutes from now
09:00` into a dated note, let Kairos register it, close Obsidian, and wait. If the
phone stays silent, the alarm is the part to question — not the sync, which the
list itself proves.
