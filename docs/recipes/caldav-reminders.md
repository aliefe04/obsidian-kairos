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

Installed 2026-09-11 on the Debian 12 box (`192.168.1.56`), beside the other
stacks under `/opt`:

| | |
| --- | --- |
| Path | `/opt/radicale/` (`docker-compose.yml`, `config.toml`, `users`, `collections/`, `.caldav-password`) |
| Image | `tomsquest/docker-radicale:latest`, digest `sha256:0f1b45abed8b…` |
| Ports | `0.0.0.0:5232` |
| Password | `/opt/radicale/.caldav-password` (mode 600, root only). The file ends with a newline: **copy the 28 characters, not the line.** A credential carrying that line break is rejected — measured on this server, the file's bytes answer `401` and the same bytes with `\r`/`\n` removed answer `207`. The plugin drops line breaks from the password for exactly this reason, so it is safe in the plugin's own field, but the iOS account field gets no such help |
| Collection URL (the plugin setting) | `http://192.168.1.56:5232/kairos/kairos/` — created ahead of time with an authenticated `MKCALENDAR` (`201`, then `PROPFIND` `207`) and named with `PROPPATCH`, so Reminders shows a list called *Kairos* as soon as the account is added, without waiting for a first reminder |
| Account URL (the iOS setting) | `https://192.168.1.56:5233/kairos/` — the **server**, not the collection, and over **TLS**. iOS asks for `current-user-principal` and finds the collection itself; measured on this server, `/` answers `/kairos/` as the principal and `/kairos/` lists `kairos/kairos`. Pointing the account at the collection path instead is the usual cause of "CalDAV Account Verification Failed" |
| TLS front | `caddy-kairos` (`caddy:2-alpine`, `network_mode: host`, `/opt/caddy/`), `https://192.168.1.56:5233` and `https://192.168.3.56:5233` → `127.0.0.1:5232`, serving a leaf from **this deployment's own CA** (`/opt/caddy/kairos-ca.sh`; root ten years, leaf two years, both addresses in the leaf's SAN) loaded with `tls <cert> <key>`. Radicale itself is untouched on 5232, which is what the plugin on the desktop uses. **Not** `tls internal`: that issues one certificate per name, which a no-SNI client cannot choose between, and Caddy's local authority signs with a short-lived intermediate it rotates (measured: seven days, against a leaf claiming two years) — a hand-signed leaf would break the installed chain a week later with nothing changed on this side. Refresh with `sh /opt/caddy/kairos-ca.sh` then a restart; the root is reused, so the certificate already on the phone keeps working. `sh /opt/caddy/tls-check.sh` prints what a client actually receives |
| Addresses | The box has one interface, `192.168.1.56`. `192.168.3.56` also reaches it, through the router, and that is the address this deployment's phone was showing. The front is configured for **both**, and an **IP-literal client sends no SNI** — so the certificate cannot be chosen per name the way Caddy's `tls internal` would. The leaf is therefore issued ahead of time carrying **both** addresses in its SAN (`/opt/caddy/kairos-ca.sh`) and loaded with `tls <cert> <key>`; a no-SNI handshake is what to check, since that is what a client using a bare IP performs |
| CA certificate | Served for installation at `http://192.168.1.56:5234/kairos-ca.crt` from the same container, so installing it does not depend on another machine being awake. A public key: nothing secret is exposed by serving it |

**Observed: over plain HTTP the account never authenticated.** With the account
pointed at `http://…:5232/`, the phone's own DAV clients reached the server and
were refused without ever presenting the password: eleven `PROPFIND` requests
from the phone (`iOS/26.3 accountsd`, `remindd`, `dataaccessd`) each logged
`Access to '/kairos/' denied for anonymous user`, answered `401`, and **not one**
produced a `207`. The server side is not in question — the same requests with
credentials answer `207` at every step, anonymously answer `401` with a correct
`WWW-Authenticate: Basic` challenge, and both the root and the principal were
probed.

**Why the credential was never presented is not measured.** The likeliest
reading is that iOS does not send a password over a cleartext connection, and an
account that never completed verification sends nothing on any transport either,
so these logs cannot separate the two. `[INFERENCE]`, and the TLS front below is
the experiment: Caddy's access log records both the `Host` and whether an
`Authorization` header was presented, so the first attempt over HTTPS settles it.
If requests still arrive anonymous over TLS, the transport was not the cause and
the account's own state is — which is why the TLS front is worth having either
way, as it is also what makes the attempt observable.

Verified over the network from another machine with the channel's own code (not
`curl`): the collection was created on the first write, a Turkish title survived
escaping and folding, moving the due time left exactly one resource, and the
delete returned the task to `404`. The account used for that run was removed
afterwards; only `kairos` remains.

Note the server already runs a `cloudflared` tunnel for other services, and it is
managing the tunnel by token, so its ingress is not editable on disk. Publishing
this collection through it would give the phone a public HTTPS name with a
certificate iOS trusts without any profile install — attractive, but it exposes
the reminder collection to the internet and changes a tunnel other services
depend on, so it is left for a deliberate decision. The local-CA front below is
what this deployment uses instead: LAN-only, no public exposure.

## Reachability

**Prefer TLS, and do not count on *Use SSL off*.** The account was added against
`http://192.168.1.56:5232/` with *Use SSL* off and an explicit port, and
verification failed: iOS `PROPFIND`s arrived anonymously and were refused, with no
credential ever presented (see the deployment table above). An earlier version of
this recipe presented that combination as "fiddly but workable"; nothing had
measured it. Plain-HTTP CalDAV accounts demonstrably work elsewhere, so this is
not a general rule about HTTP — it is what this deployment did, with the cause
still open. What TLS does buy regardless is observability, and it removes the
transport from the list of suspects. Provide it one of these ways:

- **A local CA (what this deployment does)**: Caddy in front of `127.0.0.1:5232`
  on a second port, serving a leaf from the deployment's own CA, with the CA root
  installed and trusted once on the phone. No domain, no public exposure, works on
  a LAN. Two details that are easy to get wrong and were both measured here: the
  root needs **two steps** — install the profile, *then* enable it under
  **Settings → General → About → Certificate Trust Settings**, since skipping the
  second leaves a certificate the phone still refuses; and the leaf has to cover
  **every** address the phone might use, because a client connecting to a bare IP
  sends no SNI and `tls internal` can only issue one name per certificate.
- **On a tailnet**: `tailscale serve --bg 5232` gives the machine a
  `https://<host>.<tailnet>.ts.net/` name with a certificate iOS already trusts,
  so nothing has to be installed on the phone. Prefer this when the machine is on
  a tailnet: it is less work and reaches the phone from anywhere.
- **On a VPS with a domain**: a Caddy or nginx reverse proxy in front of
  `127.0.0.1:5232` with a Let's Encrypt certificate.
- **LAN only**: bind to the LAN address and accept that reminders written away
  from home are registered when the phone comes back.

Whichever you pick, the **server** has to be the same one the plugin writes to —
one Radicale, reached by one path. The two URLs are not identical, and need not
be: the plugin takes the collection over whatever address it reaches the server
on (`http://192.168.1.56:5232/kairos/kairos/` in this deployment), while the iOS
account takes the server root over TLS (`https://192.168.1.56:5233/kairos/`).
Both land on the same collection, which is what matters: two different servers,
or two different collections on one server, would put the phone's list and the
plugin's writes in separate places and neither would see the other.

A TLS front also gives the one piece of evidence a failing account otherwise
hides: its access log records every request's host, status and whether a
credential was presented at all, which is what separates "the phone cannot reach
the server" from "the phone reached it and would not authenticate".

## Two devices, one vault

A reminder's instance id — and so the name of every registration made from it —
is derived partly from the vault's identity, and the record that says a reminder
has already been registered lives in the state folder. Two devices writing the
same vault therefore have to agree on **both**, or each makes and keeps its own
copy of the same reminder: one line becomes two tasks in Reminders, two pushes on
the phone, and neither device can withdraw the other's entry.

- **The identity is in the vault**, at `<state folder>/vault-id`. A vault sync
  carries it, so both devices derive the same ids. A value already in the plugin's
  `data.json` is written out rather than replaced, so an existing vault keeps the
  ids its state files and server entries are named after.
- **Share the state folder.** `State location` → **Vault folder**, with a
  **visible** folder name (the default is `kairos`): sync tools commonly skip
  dot-folders, and a state folder that does not arrive on the second device
  leaves the two engines independent.
- Whether `.obsidian` syncs is not something to rely on either way. The plugin's
  own settings may travel with a sync service's internal-file support while the
  vault folder does not, or the reverse; the vault folder is the one to check.

**This applies to every server-scheduled channel, not just the calendar.** A
second device with `ntfy` enabled on the same topic duplicates the alert exactly
the way a second CalDAV writer duplicates the task: each device keeps its own
record of what it published, so both publish, and the phone rings twice for one
line. Turning one channel off and leaving the other is not enough.

To tell whether the second device is sharing rather than duplicating, look in the
vault's state folder: it holds a `state/devices/<id>.json` per device that has
registered something. A reminder registered by the other device already carries
its push ids — one per channel — and the registration pass skips any channel whose
id the record already holds, so it is not published a second time. If those per-
device files are not arriving on the second device, its records are its own and
every channel it has enabled will publish again.

A shared registry has one window it cannot close: the two devices' records have to
meet, and a sync takes time, so a reminder written on both devices in the same
moment can still be registered by each. Nothing local fixes that; it is the reason
one writer and one reader is the safer arrangement when the sync is not
instant.

## The iPhone

Two URLs are in play and they are not the same one. The **plugin** wants the
collection (`…/kairos/kairos/`); the **iOS account** wants the server
(`…/kairos/` or the bare address), because iOS discovers the collection itself by
asking for the current user principal. Pointing the account at the collection is
the usual cause of *"CalDAV Account Verification Failed"*.

1. **Install the CA certificate first.** In Safari on the phone, open
   `http://192.168.1.56:5234/kairos-ca.crt` (or `…192.168.3.56…` — see below)
   → *Allow* the profile → **Settings → Profile Downloaded → Install** → then
   **Settings → General → About → Certificate Trust Settings** and switch on
   *Kairos Local CA*. Both steps are required; the profile alone leaves a
   certificate the phone still refuses. (An earlier attempt on this deployment
   installed *Caddy Local Authority* instead; if that entry is still in the list,
   enabling it changes nothing — the served root is `Kairos Local CA`.)
2. **Settings → Reminders → Reminders Accounts → Add Account → Other → Add
   CalDAV Account.** (Under Reminders, not under Calendar — that is where the
   lists end up.)
3. Server: `192.168.1.56`, or `192.168.3.56` if that is what the phone already
   reaches the box on — a certificate is issued for each, so either works, and
   using the one the phone already has avoids the mismatch that reads as a wrong
   password. User name `kairos`, password: paste the 28 characters
   from `/opt/radicale/.caldav-password` without the trailing line break.
4. **Next** should now succeed. If it does not, go **Back → Advanced Settings**
   and confirm **Use SSL on**, **Port** `5233`, and the account URL
   `https://192.168.1.56:5233/kairos/` (the same address you put in the Server
   field). Over plain `http://…:5232` this account never authenticated — the
   requests arrived, were refused, and never carried the password; see
   *Reachability* for the observation and for what is still inference.
5. When asked which apps to use the account with, tick **Reminders**.
6. Open Reminders: a list called **Kairos** is there, and tasks written by Kairos
   arrive in it.

**Check the network path in Safari first.** Open `https://192.168.1.56:5233/` on
the phone (after installing the certificate). If Safari cannot load it, the
account never will — fix the network (same LAN, or the WireGuard profile the
server already runs) before retrying.

If Reminders shows no list after a *successful* login, retry the account URL as
the principal (`https://192.168.1.56:5233/kairos/`), then as the collection
(`…/kairos/kairos/`).

## What is verified, and what still needs the phone

| Link | Evidence |
| --- | --- |
| Write, update in place, delete against a real CalDAV server | Verified locally against Radicale, container log and `PROPFIND` listing: a second write of the same instance left one resource, `404` after the delete |
| A collection that does not exist yet | Verified: `MKCALENDAR` then retry, against an empty server |
| Third-party CalDAV lists appear in iOS Reminders | Documented by Nextcloud Tasks (client list) and by iOS's account type; not measured here |
| **A `VTODO` with a `VALARM` actually alarms on iOS** | **Not verified.** No one involved can measure it from outside an iPhone. Treat the alarm as unconfirmed until a reminder written on the Mac rings on the phone at its due minute (`docs/risks.md`, R15) |
| The channel against the deployed server, over the network | Verified from another machine with the plugin's own code: bootstrap, Turkish title folded and escaped, one resource after a due-time move, `404` after the delete. The account it authenticated with was created with **bcrypt** (`$2b$12$`) by the one-liner above, so that path is exercised, not just written down |
| Registration ahead of time, withdrawal on completion | Engine-level, covered by `tests/schedule.perChannelPush.test.ts`: an entry stays while its line is in the note — including after it has fired, since Reminders is where the user ticks it off — and is deleted when the line goes, when the reminder is muted, or when it is acknowledged |
| Registration and withdrawal against the deployed server | Verified live: a line added to a dated note registered on both channels in one pass and landed as a `VTODO` on the server, and deleting the line withdrew it (the resource was gone from the collection on the next listing) |
| A fire that wrote the entry holding no handle | Verified live: the caught-up entry is swept by instance id when its line departs, since there is no handle to withdraw by |
| The iOS path's TLS chain | Verified from a LAN client with the root installed and `-k` **not** used: `curl --cacert` answers `401` (the expected challenge) with `SSL certificate verify ok`, and a **no-SNI** handshake — what a client using a bare IP performs — returns a leaf carrying `IP 192.168.1.56, IP 192.168.3.56`, with the intermediate sent alongside it. Without the root the same request fails (`verify=20`), so the check is meaningful |
| The vault id is written where a sync will carry it | Verified live: a real Obsidian wrote `<vault folder>/vault-id` on first launch, and both that file and the state folder were present in the sync database for the second device to pull |

The cheap way to settle the last line: write `- [ ] test 5 minutes from now
09:00` into a dated note, let Kairos register it, close Obsidian, and wait. If the
phone stays silent, the alarm is the part to question — not the sync, which the
list itself proves.
