<?php

/**
 * Tiny assertion helper shared by the PHP tests (no framework needed).
 */

require_once __DIR__ . '/../../library/Topologygraph/Common/Aggregation.php';
require_once __DIR__ . '/../../library/Topologygraph/Common/GraphBuilder.php';
require_once __DIR__ . '/../../library/Topologygraph/Common/GraphSource.php';
require_once __DIR__ . '/../../library/Topologygraph/Common/GraphExplain.php';
require_once __DIR__ . '/../../library/Topologygraph/Common/HostGroupPatterns.php';
require_once __DIR__ . '/../../library/Topologygraph/Common/JsonCache.php';

$GLOBALS['failures'] = 0;
$GLOBALS['checks'] = 0;

function check($description, $actual, $expected)
{
    $GLOBALS['checks']++;
    if ($actual === $expected) {
        echo "ok    $description\n";
    } else {
        $GLOBALS['failures']++;
        echo "FAIL  $description\n";
        echo "      expected: " . json_encode($expected) . "\n";
        echo "      actual:   " . json_encode($actual) . "\n";
    }
}

function finish()
{
    echo "\n{$GLOBALS['checks']} checks, {$GLOBALS['failures']} failed\n";
    exit($GLOBALS['failures'] ? 1 : 0);
}
