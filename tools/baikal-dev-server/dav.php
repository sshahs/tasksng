<?php
/**
 * Baikal-equivalent CalDAV endpoint for local development and tests.
 *
 * Baikal is a thin admin UI around sabre/dav; this script wires up the same
 * backends and plugins as Baikal's Core\Server so the app can be tested
 * without a full Baikal installation.
 *
 * Environment:
 *   BAIKAL_AUTH  "Digest" (Baikal's default) or "Basic"
 *   BAIKAL_DB    path to the SQLite database (created on first run)
 */

require __DIR__.'/vendor/autoload.php';

date_default_timezone_set('UTC');
error_reporting(E_ALL & ~E_DEPRECATED);

$realm = 'BaikalDAV';
$authType = getenv('BAIKAL_AUTH') ?: 'Digest';
$dbPath = getenv('BAIKAL_DB') ?: __DIR__.'/data/db.sqlite';

$fresh = !file_exists($dbPath);
if ($fresh && !is_dir(dirname($dbPath))) {
    mkdir(dirname($dbPath), 0777, true);
}
$pdo = new PDO('sqlite:'.$dbPath);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

if ($fresh) {
    foreach (array_filter(array_map('trim', explode(';', file_get_contents(__DIR__.'/schema.sql')))) as $stmt) {
        $pdo->exec($stmt);
    }
    // The schema's sample data contains admin/admin; replace it with Baikal-like users.
    $pdo->exec('DELETE FROM users');
    $pdo->exec('DELETE FROM principals');
    foreach (['test' => 'test', 'other' => 'other'] as $user => $password) {
        $pdo->prepare('INSERT INTO users (username, digesta1) VALUES (?, ?)')
            ->execute([$user, md5("$user:$realm:$password")]);
        foreach (['', '/calendar-proxy-read', '/calendar-proxy-write'] as $suffix) {
            $pdo->prepare('INSERT INTO principals (uri, email, displayname) VALUES (?, ?, ?)')
                ->execute(["principals/$user$suffix", "$user@example.com", ucfirst($user)]);
        }
        // Baikal creates a "Default calendar" for events and tasks.
        $backend = new Sabre\CalDAV\Backend\PDO($pdo);
        $backend->createCalendar("principals/$user", 'default', [
            '{DAV:}displayname' => 'Default calendar',
            '{http://apple.com/ns/ical/}calendar-color' => '#2563EBFF',
            '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set' => new Sabre\CalDAV\Xml\Property\SupportedCalendarComponentSet(['VEVENT', 'VTODO']),
        ]);
        $backend->createCalendar("principals/$user", 'events', [
            '{DAV:}displayname' => 'Events only',
            '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set' => new Sabre\CalDAV\Xml\Property\SupportedCalendarComponentSet(['VEVENT']),
        ]);
    }
}

if ($authType === 'Basic') {
    $authBackend = new Sabre\DAV\Auth\Backend\BasicCallBack(function ($username, $password) use ($pdo, $realm) {
        $stmt = $pdo->prepare('SELECT digesta1 FROM users WHERE username = ?');
        $stmt->execute([$username]);
        $hash = $stmt->fetchColumn();
        return $hash && hash_equals($hash, md5("$username:$realm:$password"));
    });
    $authBackend->setRealm($realm);
} else {
    $authBackend = new Sabre\DAV\Auth\Backend\PDO($pdo);
    $authBackend->setRealm($realm);
}

$principalBackend = new Sabre\DAVACL\PrincipalBackend\PDO($pdo);
$calendarBackend = new Sabre\CalDAV\Backend\PDO($pdo);

$server = new Sabre\DAV\Server([
    new Sabre\CalDAV\Principal\Collection($principalBackend),
    new Sabre\CalDAV\CalendarRoot($principalBackend, $calendarBackend),
]);
$server->setBaseUri('/dav.php/');

$server->addPlugin(new Sabre\DAV\Auth\Plugin($authBackend));
$server->addPlugin(new Sabre\DAVACL\Plugin());
$server->addPlugin(new Sabre\DAV\Browser\Plugin());
$server->addPlugin(new Sabre\DAV\PropertyStorage\Plugin(new Sabre\DAV\PropertyStorage\Backend\PDO($pdo)));
$server->addPlugin(new Sabre\DAV\Sync\Plugin());
$server->addPlugin(new Sabre\CalDAV\Plugin());
$server->addPlugin(new Sabre\CalDAV\ICSExportPlugin());
$server->addPlugin(new Sabre\CalDAV\Schedule\Plugin());
$server->addPlugin(new Sabre\DAV\Sharing\Plugin());
$server->addPlugin(new Sabre\CalDAV\SharingPlugin());

$server->start();
