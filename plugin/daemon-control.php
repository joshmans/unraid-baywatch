<?php
/**
 * Action handler for controlling the unraid-baywatch daemon from
 * the plugin's own page - deliberately outside the Node daemon's own API,
 * since the whole point is working when that daemon is down (can't ask a
 * dead process to start itself).
 *
 * Auth: the same CSRF-token pattern real installed Unraid plugins use for
 * this (confirmed against unraid-zram-card's zram_actions.php on a live
 * box, not invented here) - validate the caller's csrf_token against
 * Unraid's own current token in var.ini. hash_equals() avoids a timing
 * side-channel; an unreadable var.ini fails closed (empty server token
 * never matches).
 */

$PIDFILE = '/var/run/unraid-baywatch.pid';
$LAYOUT_PATH = '/boot/config/plugins/unraid-baywatch/layout.json';
$RC_SCRIPT = '/usr/local/etc/rc.d/rc.unraid-baywatch';
$DEFAULT_PORT = 3838;

header('Content-Type: application/json');

$csrf = filter_input(INPUT_GET, 'csrf_token', FILTER_UNSAFE_RAW) ?: '';
$var = @parse_ini_file('/var/local/emhttp/var.ini', false, INI_SCANNER_RAW) ?: [];
$serverCsrf = (string)($var['csrf_token'] ?? '');
if ($serverCsrf === '' || !hash_equals($serverCsrf, $csrf)) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Missing or invalid CSRF token']);
    exit;
}

function dln_read_port($layoutPath, $defaultPort) {
    $data = @json_decode(@file_get_contents($layoutPath), true);
    $port = is_array($data) ? ($data['port'] ?? null) : null;
    return (is_int($port) && $port >= 1 && $port <= 65535) ? $port : $defaultPort;
}

function dln_is_running($pidfile) {
    $pid = trim((string)@file_get_contents($pidfile));
    return $pid !== '' && ctype_digit($pid) && file_exists("/proc/$pid");
}

$action = filter_input(INPUT_GET, 'action', FILTER_UNSAFE_RAW) ?: '';

if ($action === 'status') {
    echo json_encode([
        'running' => dln_is_running($PIDFILE),
        'port' => dln_read_port($LAYOUT_PATH, $DEFAULT_PORT),
    ]);
    exit;
}

if ($action === 'start') {
    // Always restart, never plain start - the rc.d script's start() already
    // no-ops cleanly if it's already running, so this one action covers
    // both the "start" and "restart" cases the UI needs.
    exec(escapeshellarg($RC_SCRIPT) . ' restart 2>&1', $output, $code);
    echo json_encode([
        'success' => $code === 0,
        'message' => implode("\n", $output),
    ]);
    exit;
}

if ($action === 'stop') {
    exec(escapeshellarg($RC_SCRIPT) . ' stop 2>&1', $output, $code);
    echo json_encode([
        'success' => $code === 0,
        'message' => implode("\n", $output),
    ]);
    exit;
}

if ($action === 'set-port') {
    if (dln_is_running($PIDFILE)) {
        echo json_encode(['success' => false, 'message' => 'Stop the daemon before changing its port']);
        exit;
    }
    $port = filter_input(INPUT_GET, 'port', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
    if ($port === false || $port === null) {
        echo json_encode(['success' => false, 'message' => 'Port must be an integer between 1 and 65535']);
        exit;
    }
    $data = @json_decode(@file_get_contents($LAYOUT_PATH), true);
    if (!is_array($data)) {
        // No layout.json yet (fresh install) - seed the same minimal, valid
        // structure App.svelte's own emptyLayout constant uses, so the
        // frontend never has to handle a document missing layout/logos.
        $data = ['layout' => ['id' => 'custom', 'name' => 'My chassis', 'groups' => []], 'logos' => (object)[]];
    }
    $data['port'] = $port;
    @mkdir(dirname($LAYOUT_PATH), 0755, true);
    if (@file_put_contents($LAYOUT_PATH, json_encode($data, JSON_PRETTY_PRINT)) === false) {
        echo json_encode(['success' => false, 'message' => "Couldn't write $LAYOUT_PATH"]);
        exit;
    }
    echo json_encode(['success' => true, 'message' => "Port saved ($port) - start the daemon to apply it"]);
    exit;
}

echo json_encode(['success' => false, 'message' => "Unknown action: $action"]);
