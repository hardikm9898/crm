# infra/config

One Zod schema for every environment variable, validated **at boot**. A malformed or missing variable
fails the process immediately with the variable named, rather than surfacing as a confusing error
under load three hours later.

- `APP_CONFIG` is the injectable token; nothing outside this directory reads `process.env`.
- `ROLE` selects the process shape (`api` | `collector` | `worker` | `scheduler`).

**The production safety net is the point of the file.** Beyond shape validation it refuses to start in
production with a development-only configuration: a default or short secret, a development mailer, a
permissive CORS origin. Each of those is individually harmless in development and individually a
breach in production, so the check lives where it cannot be skipped.

Nest hides boot failures behind `process.abort()`, which is why tests construct the app with
`abortOnError: false` — otherwise a configuration test looks like a crashed worker.
