<?php
// Router for PHP's built-in web server: php -S 127.0.0.1:8800 router.php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if (str_starts_with($path, '/.well-known/caldav')) {
    // Same as Baikal's recommended web server configuration.
    header('Location: /dav.php/', true, 301);
    return true;
}
if ($path === '/dav.php' || str_starts_with($path, '/dav.php/')) {
    require __DIR__.'/dav.php';
    return true;
}
http_response_code(404);
echo "Baikal dev server: CalDAV lives at /dav.php/\n";
return true;
