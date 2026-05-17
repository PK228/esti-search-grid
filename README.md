# Esti Search Grid

Emergency search-grid prototype for the area bounded by Keele Street, Yonge
Street, Steeles Avenue, and Eglinton Avenue in Toronto.

Volunteer instructions are in [VOLUNTEER_README.md](VOLUNTEER_README.md).

## Run locally

```bash
python3 -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

Browser GPS works on `localhost` and HTTPS. It usually will not work from a
plain `file://` URL.

## Current behavior

- Generates 0.5 kilometer grid squares over the target area.
- Shows OpenStreetMap streets under the grid.
- Creates a temporary browser session identity and persistent volunteer ID.
- Lets a volunteer tap a grid and mark it as searching, complete, stopped,
  needing backup, emergency, or found.
- Attributes every grid update to volunteer name, phone, team, user ID, and
  session ID.
- Creates an audit event for each meaningful action: timestamp, user, grid,
  action type, and details.
- Syncs grid cells, audit events, and incidents through a shared Vercel API
  backed by Upstash Redis.
- Supports manual heartbeat updates on active search grids.
- Auto-releases grids after 30 minutes without heartbeat and preserves the
  release in the audit trail.
- Includes dispatcher mode, command metrics, incident log, audit log, heat-map
  mode, duplicate-claim blocking, and JSON import/export.
- Saves state in the current browser with `localStorage`.

## Dispatcher mode

This local prototype uses PIN `2468` for dispatcher mode. It is only a local
prototype control, not secure authentication.

## Phone verification

Phone verification is implemented as a local demo code flow so the UI and audit
model are ready. Real verification requires a backend/SMS provider such as
Supabase Auth, Twilio, Firebase Auth, or another OTP service.

## Shared backend

The shared state endpoint is:

```text
/api/state
```

On Vercel it uses the Upstash Redis environment variables provisioned by the
Vercel Marketplace integration. On GitHub Pages, the frontend calls the Vercel
API at `https://esti-search-grid.vercel.app/api/state`.

## Important next step

The backend now shares grid status across phones. Phone verification and
dispatcher mode are still local/demo controls; for a production response system,
move those to real authentication and server-side roles.
