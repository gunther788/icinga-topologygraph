<?php

namespace Icinga\Module\Topologygraph\Common;

/**
 * Turns Icinga 2 API results into the graph the front end draws.
 *
 * Pure array work with no Icinga Web dependencies, so it can be tested on its
 * own (see tests/php/GraphBuilderTest.php).
 */
final class GraphBuilder
{
    /** Service states, worst first, for picking a host's worst service problem */
    const SERVICE_SEVERITY = ['critical' => 3, 'unknown' => 2, 'warning' => 1, 'ok' => 0];

    /**
     * Pick the hosts to draw and the parent -> child links between them.
     *
     * Every host in one of $groups is drawn, plus any direct parent or child of one that
     * is outside the group, so chains don't break. Only host-to-host
     * dependencies are used; service dependencies are ignored.
     *
     * @param array  $hosts        API results from objects/hosts (with attrs.groups)
     * @param array  $dependencies API results from objects/dependencies
     * @param string|string[] $groups Host group(s) to draw
     *
     * @return array ['names' => string[], 'members' => [name => true], 'links' => [['source', 'target']...]]
     */
    public static function select(array $hosts, array $dependencies, $groups)
    {
        $groups = array_map('strval', (array) $groups);
        $members = [];
        foreach ($hosts as $host) {
            if (array_intersect($groups, array_map('strval', (array) ($host['attrs']['groups'] ?? [])))) {
                $members[(string) $host['name']] = true;
            }
        }

        $links = [];
        foreach ($dependencies as $dependency) {
            $attrs = $dependency['attrs'] ?? [];
            if (! empty($attrs['child_service_name'])) {
                continue;
            }
            $parent = (string) ($attrs['parent_host_name'] ?? '');
            $child = (string) ($attrs['child_host_name'] ?? '');
            if ($parent === '' || $child === '' || $parent === $child) {
                continue;
            }
            if (! isset($members[$parent]) && ! isset($members[$child])) {
                continue;
            }
            $links[$parent . "\0" . $child] = ['source' => $parent, 'target' => $child];
        }

        $names = $members;
        foreach ($links as $link) {
            $names[$link['source']] = true;
            $names[$link['target']] = true;
        }

        return [
            // PHP turns numeric string keys into ints; cast them back
            'names'     => array_map('strval', array_keys($names)),
            'members'   => $members,
            'links'     => array_values($links)
        ];
    }

    /**
     * Add the host-to-host dependencies between hosts already in the
     * selection that select() left out (those with neither end in the group,
     * e.g. between two hosts outside the group that are both drawn). Never
     * adds hosts.
     *
     * @param array $selection    Result of select()
     * @param array $dependencies API results from objects/dependencies
     *
     * @return array The selection with the extra links
     */
    public static function addLinksAmong(array $selection, array $dependencies)
    {
        $drawn = array_flip($selection['names']);
        $links = [];
        foreach ($selection['links'] as $link) {
            $links[$link['source'] . "\0" . $link['target']] = $link;
        }
        foreach ($dependencies as $dependency) {
            $attrs = $dependency['attrs'] ?? [];
            if (! empty($attrs['child_service_name'])) {
                continue;
            }
            $parent = (string) ($attrs['parent_host_name'] ?? '');
            $child = (string) ($attrs['child_host_name'] ?? '');
            if ($parent === $child || ! isset($drawn[$parent]) || ! isset($drawn[$child])) {
                continue;
            }
            $links[$parent . "\0" . $child] = ['source' => $parent, 'target' => $child];
        }
        $selection['links'] = array_values($links);

        return $selection;
    }

    /**
     * Summarise services per host.
     *
     * A service is pending until its first check, and a problem (warning,
     * critical or unknown) is handled when it is acknowledged or in downtime.
     *
     * @param array $services     API results from objects/services
     * @param bool  $onlyNotified Leave out services with notifications disabled
     *
     * @return array host name => ['total', 'ok', 'warning', 'critical', 'unknown', 'pending',
     *                             'unhandled', 'worst', 'worst_unhandled']
     */
    public static function summariseServices(array $services, $onlyNotified = false)
    {
        $names = [0 => 'ok', 1 => 'warning', 2 => 'critical', 3 => 'unknown'];
        $summary = [];
        foreach ($services as $service) {
            $attrs = $service['attrs'] ?? [];
            $host = (string) ($attrs['host_name'] ?? '');
            if ($host === '') {
                continue;
            }
            if ($onlyNotified && ($attrs['enable_notifications'] ?? true) === false) {
                continue;
            }
            if (! isset($summary[$host])) {
                $summary[$host] = [
                    'total' => 0, 'ok' => 0, 'warning' => 0, 'critical' => 0, 'unknown' => 0, 'pending' => 0,
                    'unhandled' => 0, 'worst' => null, 'worst_unhandled' => null
                ];
            }
            $entry = &$summary[$host];
            $entry['total']++;

            if (($attrs['last_check'] ?? 0) <= 0) {
                $entry['pending']++;
                unset($entry);
                continue;
            }

            $state = $names[(int) ($attrs['state'] ?? 3)] ?? 'unknown';
            $entry[$state]++;
            $entry['worst'] = self::worse($entry['worst'], $state);

            $handled = ($attrs['acknowledgement'] ?? 0) > 0 || ($attrs['downtime_depth'] ?? 0) > 0;
            if ($state !== 'ok' && ! $handled) {
                $entry['unhandled']++;
                $entry['worst_unhandled'] = self::worse($entry['worst_unhandled'], $state);
            }
            unset($entry);
        }

        return $summary;
    }

    /**
     * Build the data for the front end.
     *
     * @param array      $selection Result of select()
     * @param array      $hosts     API results from objects/hosts
     * @param array|null $services  API results from objects/services, or null if they couldn't be fetched
     * @param string     $hostPath  Icinga Web URL prefix for a host's detail page
     *
     * @return array ['nodes' => [...], 'links' => [...]]
     */
    /** Host variable holding a synthetic host's members and mode */
    const AGGREGATE_VAR = 'synthetic';

    /**
     * A synthetic host's aggregation: its members, the mode, how many members
     * must be up (any: 1, all: all of them, quorum: a majority, or a number),
     * and which members are up, down, or not known to Icinga.
     *
     * @param array|null $attrs       The host's attributes (with vars)
     * @param array      $hostsByName Attributes of the hosts fetched, by name
     *
     * @return array|null
     */
    public static function aggregate($attrs, array $hostsByName)
    {
        $vars = $attrs['vars'][self::AGGREGATE_VAR] ?? null;
        if (! is_array($vars) || empty($vars['members']) || ! is_array($vars['members'])) {
            return null;
        }
        $members = array_values(array_unique(array_map('strval', $vars['members'])));
        $total = count($members);
        $mode = isset($vars['mode']) ? strtolower(trim((string) $vars['mode'])) : 'all';
        if ($mode === 'any') {
            $needed = 1;
        } elseif ($mode === 'all') {
            $needed = $total;
        } elseif ($mode === 'quorum') {
            $needed = intdiv($total, 2) + 1;
        } elseif (ctype_digit($mode)) {
            $needed = min($total, (int) $mode);
        } else {
            $needed = null; // a mode this module doesn't know: no threshold
        }

        $up = $down = $unknown = [];
        foreach ($members as $member) {
            $host = $hostsByName[$member] ?? null;
            if ($host === null) {
                $unknown[] = $member;
            } elseif (($host['state'] ?? null) === 0 || ($host['state'] ?? null) === 0.0) {
                if (($host['last_check'] ?? 0) > 0) {
                    $up[] = $member;
                } else {
                    $unknown[] = $member; // pending
                }
            } else {
                $down[] = $member;
            }
        }

        return [
            'mode'    => $mode,
            'needed'  => $needed,
            'total'   => $total,
            'members' => $members,
            'up'      => $up,
            'down'    => $down,
            'unknown' => $unknown
        ];
    }

    /** Members of the synthetic hosts among $hosts */
    public static function aggregateMembers(array $hosts)
    {
        $members = [];
        foreach ($hosts as $host) {
            $vars = $host['attrs']['vars'][self::AGGREGATE_VAR] ?? null;
            if (is_array($vars) && ! empty($vars['members']) && is_array($vars['members'])) {
                foreach ($vars['members'] as $member) {
                    $members[(string) $member] = true;
                }
            }
        }

        return array_map('strval', array_keys($members));
    }

    public static function build(array $selection, array $hosts, $services, $hostPath)
    {
        $hostsByName = [];
        foreach ($hosts as $host) {
            $hostsByName[(string) $host['name']] = $host['attrs'] ?? [];
        }
        $serviceSummary = $services === null ? null : self::summariseServices($services);
        $notifiedSummary = $services === null ? null : self::summariseServices($services, true);
        $noServices = [
            'total' => 0, 'ok' => 0, 'warning' => 0, 'critical' => 0, 'unknown' => 0, 'pending' => 0,
            'unhandled' => 0, 'worst' => null, 'worst_unhandled' => null
        ];

        $nodes = [];
        foreach ($selection['names'] as $name) {
            $attrs = $hostsByName[$name] ?? null;
            $nodes[] = [
                'name'         => $name,
                'label'        => $attrs['display_name'] ?? $name,
                'state'        => $attrs['state'] ?? null,
                'last_check'   => $attrs['last_check'] ?? null,
                'zone'         => $attrs['zone'] ?? null,
                // Down only because a parent is down
                'reachable'    => $attrs === null ? true : (bool) ($attrs['last_reachable'] ?? true),
                'acknowledged' => ($attrs['acknowledgement'] ?? 0) > 0,
                'in_downtime'  => ($attrs['downtime_depth'] ?? 0) > 0,
                // null: service details unavailable (e.g. no permission)
                'services'     => $serviceSummary === null ? null : ($serviceSummary[$name] ?? $noServices),
                // The same, counting only services with notifications enabled
                'services_notified' => $notifiedSummary === null ? null : ($notifiedSummary[$name] ?? $noServices),
                // In one of the host groups being graphed
                'member'       => isset($selection['members'][$name]),
                // For a synthetic host aggregating others (vars.synthetic.members
                // and .mode): how many members it needs, and which are up
                'aggregate'    => self::aggregate($attrs, $hostsByName),
                // Host groups the host is in, for selecting a subset by group
                'groups'       => array_values(array_map('strval', (array) ($attrs['groups'] ?? []))),
                'link'         => $hostPath . rawurlencode($name)
            ];
        }

        return ['nodes' => $nodes, 'links' => $selection['links']];
    }

    private static function worse($a, $b)
    {
        if ($a === null) {
            return $b;
        }

        return self::SERVICE_SEVERITY[$b] > self::SERVICE_SEVERITY[$a] ? $b : $a;
    }
}
