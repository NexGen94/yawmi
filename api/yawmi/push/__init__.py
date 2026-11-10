"""Web Push for habit reminders.

Import cost matters here: `vapid` and `store` are light (cryptography, asyncpg) and are what the
route module needs. `sender` and `scheduler` pull in pywebpush and aiohttp; only the app's
lifespan imports them, and only when `push_enabled` is true.
"""
