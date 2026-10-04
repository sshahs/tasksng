# Baikal dev server

A CalDAV server wired up exactly like [Baikal](https://sabre.io/baikal/)
(same sabre/dav 4 backends and plugins, same `BaikalDAV` realm and
`/dav.php/` layout) for developing and testing TasksNG without a full
Baikal installation.

```sh
composer install
php -S 127.0.0.1:8800 router.php                    # Digest auth (Baikal default)
BAIKAL_AUTH=Basic php -S 127.0.0.1:8801 router.php  # Basic auth
```

Users: `test` / `test` and `other` / `other`. Each gets a "Default calendar"
(events + tasks) and an "Events only" calendar, like a fresh Baikal user.
Data is stored in `data/db.sqlite` (override with `BAIKAL_DB`); delete it to
start over.

Point the app at `http://127.0.0.1:8800` (discovery finds `/dav.php/`), or run
the integration tests:

```sh
TASKSNG_TEST_URL=http://127.0.0.1:8800 cargo test -p tasks-core --test baikal -- --test-threads=1
```
