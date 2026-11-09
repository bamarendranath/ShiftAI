# Rosterly shift planning

Rosterly is a shift-planning MVP with a browser preview and a same-origin Node.js/PostgreSQL backend. The backend supports account registration/sign-in, workspace-scoped staff and settings, and saved weekly draft schedules.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for details.

## Requirements

- Node.js 22.12 or later
- PostgreSQL 15 or later

## Run locally on Windows

1. Create a PostgreSQL database and user.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to that database. Replace the example password.
3. In PowerShell, run:

   ```powershell
   npm.cmd install
   npm.cmd run migrate
   npm.cmd start
   ```

4. Open `http://localhost:3000`, create a workspace, then add team members and availability.

`npm.cmd test` runs the automated unit and HTTP tests. The browser-only preview remains available by opening `index.html`, but that mode uses local browser storage and sample staff; do not enter real employee data there.

## Current scope

- Passwords use salted scrypt hashes. Sessions use random opaque tokens stored as hashes and HttpOnly, SameSite cookies. In production, set `NODE_ENV=production` behind HTTPS so cookies are Secure. If TLS terminates at a trusted reverse proxy, configure `TRUST_PROXY=1` only when that proxy overwrites forwarded headers.
- Data is isolated by workspace in PostgreSQL. Staff, availability, planning settings, and weekly draft assignments sync to the server.
- Schedule generation remains a simple greedy prototype with fixed 08:00–16:00 / 16:00–00:00 shifts. Drafts are not published or optimized.
- The database includes a versioned legal-rule-profile structure, but **no country or industry labor-law profiles are supplied or verified**. A profile cannot be marked active unless reviewer and source metadata are present; that database check is not legal validation. No compliance determination or legal advice is provided.

## Not production-ready

This MVP does not yet include email verification, password recovery, MFA, staff invitations/role-based access, account deletion/export workflows, backups, deployment configuration, or an external security/privacy assessment. Registration is open, and the in-memory request throttling is per process. Configure TLS, managed database access, backups, monitoring and privacy retention before any real-world deployment. Obtain qualified local review before using labor-rule data or relying on schedules.
