# Esti Search Grid

Emergency search-grid prototype for the area bounded by Keele Street, Yonge
Street, Steeles Avenue, and Eglinton Avenue in Toronto.

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

- Generates 1 kilometer grid squares over the target area.
- Shows OpenStreetMap streets under the grid.
- Creates a temporary browser session identity and persistent volunteer ID.
- Lets a volunteer tap a grid and mark it as searching, complete, stopped,
  needing backup, emergency, or found.
- Attributes every grid update to volunteer name, phone, team, user ID, and
  session ID.
- Creates an audit event for each meaningful action: timestamp, user, grid,
  action type, and details.
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

## Important next step

This prototype is local-only. For multiple volunteers to see the same live grid,
connect the cell status updates to a shared backend such as Supabase, Firebase,
or a small WebSocket/API service. The backend should own authentication,
dispatcher roles, SMS verification, audit storage, and real-time subscriptions.
