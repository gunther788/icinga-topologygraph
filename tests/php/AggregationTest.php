<?php

/**
 * Tests for Aggregation: synthetic hosts as python-icinga2-aggregator sees
 * them. Run with: php tests/php/AggregationTest.php
 */

require __DIR__ . '/lib.php';

use Icinga\Module\Topologygraph\Common\Aggregation;

function synth(array $vars)
{
    return ['vars' => ['synthetic' => $vars]];
}

// --- config() -------------------------------------------------------------------

check('config: members, groups, mode, quorum and sources', Aggregation::config(synth([
    'members' => ['a', 'b!http', 'a'], 'member_groups' => ['web', ''], 'mode' => 'Quorum ', 'quorum' => '66%', 'sources' => 'Worst'
])), ['members' => ['a', 'b'], 'member_groups' => ['web'], 'mode' => 'quorum', 'quorum' => '66%', 'sources' => 'worst']);
check('config: defaults', Aggregation::config(synth(['members' => ['a']])),
    ['members' => ['a'], 'member_groups' => [], 'mode' => 'all', 'quorum' => null, 'sources' => 'best']);
check('config: not configured (template defaults, or nothing)', [
    Aggregation::config(synth(['members' => [], 'mode' => 'unknown'])),
    Aggregation::config(synth(['members' => ['a'], 'mode' => 'unknown'])),
    Aggregation::config(['vars' => ['synthetic' => ['services' => ['http']]]]),
    Aggregation::config(['vars' => []]),
    Aggregation::config(null)
], [null, null, null, null, null]);

// --- needed() -------------------------------------------------------------------

check('needed: all, any, majority', [
    Aggregation::needed('all', null, 3), Aggregation::needed('any', null, 3),
    Aggregation::needed('quorum', null, 3), Aggregation::needed('quorum', null, 4)
], [3, 1, 2, 3]);
check('needed: a count, a percentage rounded up', [
    Aggregation::needed('quorum', 2, 5), Aggregation::needed('quorum', '66%', 3), Aggregation::needed('quorum', '50%', 5)
], [2, 2, 3]);
check('needed: a number as the mode (older configs), unknown modes', [
    Aggregation::needed('2', null, 3), Aggregation::needed('best-effort', null, 3), Aggregation::needed('quorum', 'lots', 3)
], [2, null, null]);

// --- sources() and combine() --------------------------------------------------

$h = function ($state, array $vars = [], $checked = true) {
    return ['state' => $state, 'last_check' => $checked ? 5 : 0, 'vars' => $vars];
};
$hosts = [
    'acme'        => $h(0),
    'acme-stag'   => $h(1, ['real_host' => 'acme']),
    'acme-cloud'  => $h(1, ['real_host' => 'acme']),
    'ra'          => $h(1),
    'ra-stag'     => $h(0, ['real_host' => 'ra', 'home' => true]),
    'scep-stag'   => $h(1.0, ['real_host' => 'scep']),   // the home object doesn't exist
    'idle'        => $h(0, [], false),                      // pending
    'web-1'       => $h(0, ['real_host' => 'web-1.example.net']),
    'web-1-b'     => $h(1, ['real_host' => 'web-1.example.net'])
];
$config = Aggregation::config(synth(['members' => ['acme', 'ra-stag', 'scep', 'idle', 'ghost'], 'mode' => 'quorum']));
check('sources: every host object of a real host, from any listed object', Aggregation::sources($config, $hosts, [], 'agg'), [
    'acme' => ['acme', 'acme-cloud', 'acme-stag'],
    'ra'   => ['ra', 'ra-stag'],
    'scep' => ['scep-stag'],
    'idle' => ['idle'],
    'ghost' => []
]);
check('sources: member_groups add hosts (not the synthetic host itself), once per real host', array_keys(Aggregation::sources(
    Aggregation::config(synth(['members' => ['acme'], 'member_groups' => ['web']])), $hosts,
    ['web' => ['web-1', 'web-1-b', 'acme-stag', 'agg']], 'agg'
)), ['acme', 'web-1.example.net']);

$acme = ['acme', 'acme-cloud', 'acme-stag'];
check('combine: best, worst, majority', [
    Aggregation::combine('acme', $acme, $hosts, 'best'),
    Aggregation::combine('acme', $acme, $hosts, 'worst'),
    Aggregation::combine('acme', $acme, $hosts, 'majority')
], ['up', 'down', 'down']);
check('combine: home is vars.home, else the object named like the real host, else best', [
    Aggregation::combine('ra', ['ra', 'ra-stag'], $hosts, 'home'),
    Aggregation::combine('acme', $acme, $hosts, 'home'),
    Aggregation::combine('scep', ['scep-stag'], $hosts, 'home')
], ['up', 'up', 'down']);
check('combine: pending and missing sources are left out', [
    Aggregation::combine('idle', ['idle'], $hosts, 'best'), Aggregation::combine('ghost', [], $hosts, 'best'),
    Aggregation::combine('x', ['idle', 'ra'], $hosts, 'best')
], ['unknown', 'unknown', 'down']);

// --- summary() ------------------------------------------------------------------

$s = Aggregation::summary('agg', $config, $hosts, []);
check('summary: counted per real host', [$s['total'], $s['healthy'], $s['needed'], $s['up'], $s['down'], $s['unknown']],
    [5, 2, 3, ['acme', 'ra'], ['scep'], ['idle', 'ghost']]);
check('summary: every source is drawn as a member', $s['members'], ['acme', 'acme-cloud', 'acme-stag', 'ra', 'ra-stag', 'scep-stag', 'idle']);
check('summary: the sources policy is named when a member has several', [$s['sources'], $s['from']], ['best', 'graph']);

$fromAggregator = Aggregation::summary('agg', $config, $hosts, [], [
    'output' => "WARNING: mode=quorum, healthy=3/5, quorum=3; issues: scep (DOWN)\nmembers: ...",
    'performance_data' => ['healthy=3;;3:;0;5', 'not_ok=2;;;0;5']
]);
check('summary: the aggregator\'s own counts win', [
    $fromAggregator['healthy'], $fromAggregator['needed'], $fromAggregator['total'], $fromAggregator['from'], $fromAggregator['result']
], [3, 3, 5, 'aggregator', 'WARNING: mode=quorum, healthy=3/5, quorum=3; issues: scep (DOWN)']);
check('summary: only a single source each: no policy named',
    Aggregation::summary('q', Aggregation::config(synth(['members' => ['ra'], 'mode' => 'any'])), ['ra' => $h(0)], [])['sources'], null);

check('perfdata: a string, quoted labels, and without it', [
    Aggregation::healthyPerfdata("'healthy'=2;;2:;0;3 not_ok=1;;;0;3"),
    Aggregation::healthyPerfdata(['not_ok=1;;;0;3']),
    Aggregation::healthyPerfdata(null)
], [['healthy' => 2, 'needed' => 2, 'total' => 3], null, null]);

finish();
