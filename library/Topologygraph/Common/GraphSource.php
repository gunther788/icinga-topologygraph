<?php

namespace Icinga\Module\Topologygraph\Common;

/**
 * Fetches just what the graph needs from the Icinga 2 API, in small requests
 * filtered on the Icinga side, and builds the graph with GraphBuilder:
 *
 * 1. the hosts in the group(s)
 * 2. the host-to-host dependencies that touch them
 * 3. the hosts outside the group at the other end of those dependencies, and
 *    the members of synthetic hosts in the group (vars.synthetic.members)
 * 4. the host-to-host dependencies between those outside hosts (adds lines
 *    between hosts already drawn, never more hosts)
 * 5. the services of all drawn hosts (optional: without permission, or on
 *    error, the graph is built without service details)
 * 6. only if a synthetic host has members that aren't drawn: their states,
 *    to tell how many of its members are up
 *
 * The API is passed in as a callable so this can be tested without Icinga.
 */
final class GraphSource
{
    const HOST_ATTRS = 'attrs=name&attrs=display_name&attrs=state&attrs=last_check&attrs=groups&attrs=zone'
        . '&attrs=last_reachable&attrs=acknowledgement&attrs=downtime_depth&attrs=vars';
    // Enough to count a synthetic host's members that aren't drawn
    const MEMBER_ATTRS = 'attrs=name&attrs=state&attrs=last_check&attrs=groups&attrs=vars';
    // The aggregator's result on a synthetic host's health service
    const HEALTH_ATTRS = 'attrs=host_name&attrs=last_check_result';
    const DEPENDENCY_ATTRS = 'attrs=parent_host_name&attrs=child_host_name&attrs=child_service_name'
        . '&attrs=redundancy_group';
    const SERVICE_ATTRS = 'attrs=host_name&attrs=state&attrs=last_check&attrs=acknowledgement&attrs=downtime_depth'
        . '&attrs=enable_notifications';

    /**
     * @param callable $api      function (string $endpoint, array $body): array of API results
     * @param string|string[] $group Host group(s) to draw
     * @param string   $hostPath Icinga Web URL prefix for a host's detail page
     * @param callable $onServiceError Optional: called with the exception if services can't be fetched
     *
     * @return array ['nodes' => [...], 'links' => [...]]
     */
    public static function fetch(callable $api, $group, $hostPath, ?callable $onServiceError = null)
    {
        $groups = array_values(array_unique(array_map('strval', (array) $group)));
        $groupHosts = $api('objects/hosts?' . self::HOST_ATTRS, self::inGroups($groups));
        $groupNames = self::names($groupHosts);
        if (! $groupNames) {
            return GraphBuilder::build(GraphBuilder::select([], [], $groups), [], [], $hostPath);
        }
        // Every host fetched so far, by name (drawn or not)
        $known = [];
        self::remember($known, $groupHosts);

        $dependencies = $api(
            'objects/dependencies?' . self::DEPENDENCY_ATTRS,
            [
                'filter'      => 'dependency.child_service_name == ""'
                    . ' && (dependency.parent_host_name in names || dependency.child_host_name in names)',
                'filter_vars' => ['names' => $groupNames]
            ]
        );

        $selection = GraphBuilder::select($groupHosts, $dependencies, $groups);

        // Synthetic hosts in the groups: their members are drawn, with every
        // source (host objects with the same vars.real_host), dependency or not
        $groupMembers = []; // host group => host names, for member_groups
        $synthetic = self::configs($groupHosts);
        self::fetchMembers($api, $synthetic, $known, $groupMembers, self::HOST_ATTRS);
        $selection = GraphBuilder::addAggregateMembers(
            $selection,
            self::sourcesOf($synthetic, $known, $groupMembers)
        );

        $neighbours = array_values(array_diff($selection['names'], $groupNames));
        $toFetch = array_values(array_diff($neighbours, array_keys($known)));
        self::remember($known, $toFetch ? $api(
            'objects/hosts?' . self::HOST_ATTRS,
            ['filter' => 'host.name in names', 'filter_vars' => ['names' => $toFetch]]
        ) : []);

        // Only hosts Icinga knows (a member listed in vars may not exist)
        $selection['names'] = array_values(array_filter($selection['names'], function ($name) use ($known) {
            return isset($known[$name]);
        }));
        $selection['links'] = array_values(array_filter($selection['links'], function ($link) use ($known) {
            return isset($known[$link['source']], $known[$link['target']]);
        }));
        $neighbours = array_values(array_intersect($neighbours, $selection['names']));

        // Dependencies between two drawn hosts outside the group (e.g. a host
        // in the DMZ and one in the backend) touch no group host, so step 2
        // doesn't find them
        if (count($neighbours) > 1) {
            $selection = GraphBuilder::addLinksAmong($selection, $api(
                'objects/dependencies?' . self::DEPENDENCY_ATTRS,
                [
                    'filter'      => 'dependency.child_service_name == ""'
                        . ' && dependency.parent_host_name in names && dependency.child_host_name in names',
                    'filter_vars' => ['names' => $neighbours]
                ]
            ));
        }

        try {
            $services = $api(
                'objects/services?' . self::SERVICE_ATTRS,
                ['filter' => 'host.name in names', 'filter_vars' => ['names' => $selection['names']]]
            );
        } catch (\Exception $e) {
            if ($onServiceError !== null) {
                $onServiceError($e);
            }
            $services = null;
        }

        // Synthetic hosts drawn outside the groups: their members aren't
        // drawn, but are needed for the counts
        $drawn = array_intersect_key($known, array_flip($selection['names']));
        $outside = array_diff_key(self::configs(array_values($drawn)), $synthetic);
        self::fetchMembers($api, $outside, $known, $groupMembers, self::MEMBER_ATTRS);

        // The aggregator's own results (its health service), when there are any
        $all = $synthetic + $outside;
        $health = [];
        if ($all) {
            try {
                foreach ($api('objects/services?' . self::HEALTH_ATTRS, [
                    'filter'      => 'service.name == health && host.name in names',
                    'filter_vars' => ['health' => Aggregation::HEALTH_SERVICE, 'names' => array_map('strval', array_keys($all))]
                ]) as $service) {
                    $health[(string) $service['attrs']['host_name']] = $service['attrs']['last_check_result'] ?? null;
                }
            } catch (\Exception $e) {
                // Without them, the counts are worked out here
            }
        }

        $attrs = self::attrsByName($known);
        $aggregates = [];
        foreach ($all as $name => $config) {
            $aggregates[$name] = Aggregation::summary($name, $config, $attrs, $groupMembers, $health[$name] ?? null);
        }

        return GraphBuilder::build($selection, array_values($known), $services, $hostPath, $aggregates);
    }

    /**
     * Fetch the members of synthetic hosts and every source of each (hosts
     * with the same vars.real_host), and the hosts of their member_groups
     *
     * @param callable $api
     * @param array    $configs      Synthetic host name => Aggregation::config()
     * @param array    $known        Hosts fetched so far, by name; added to
     * @param array    $groupMembers Host group => host names; added to
     * @param string   $attrs        Host attributes to fetch
     */
    private static function fetchMembers(callable $api, array $configs, array &$known, array &$groupMembers, $attrs)
    {
        if (! $configs) {
            return;
        }
        $names = [];
        $groups = [];
        foreach ($configs as $config) {
            $names = array_merge($names, $config['members']);
            $groups = array_merge($groups, $config['member_groups']);
        }
        $groups = array_values(array_diff(array_unique($groups), array_keys($groupMembers)));
        if ($groups) {
            foreach ($groups as $group) {
                $groupMembers[$group] = [];
            }
            foreach ($api('objects/hosts?' . $attrs, self::inGroups($groups)) as $host) {
                self::remember($known, [$host]);
                foreach (array_intersect($groups, (array) ($host['attrs']['groups'] ?? [])) as $group) {
                    $groupMembers[$group][] = (string) $host['name'];
                }
            }
        }
        foreach ($configs as $config) {
            foreach ($config['member_groups'] as $group) {
                $names = array_merge($names, $groupMembers[$group] ?? []);
            }
        }

        // The members, and every host naming one of them as its real host; a
        // member that is itself another host's source needs a second round
        $asked = [];
        for ($round = 0; $round < 3; $round++) {
            $ask = array_values(array_diff(array_unique($names), $asked));
            if (! $ask) {
                break;
            }
            $asked = array_merge($asked, $ask);
            $names = [];
            foreach ($api('objects/hosts?' . $attrs, [
                'filter'      => 'host.name in names || host.vars.real_host in names',
                'filter_vars' => ['names' => $ask]
            ]) as $host) {
                self::remember($known, [$host]);
                $names[] = Aggregation::realHost($host['name'], $host['attrs'] ?? []);
            }
        }
    }

    /** Synthetic host name => its aggregation config, for the hosts that have one */
    private static function configs(array $hosts)
    {
        $configs = [];
        foreach ($hosts as $host) {
            $config = Aggregation::config($host['attrs'] ?? null);
            if ($config !== null) {
                $configs[(string) $host['name']] = $config;
            }
        }

        return $configs;
    }

    /** Synthetic host name => every source of its members */
    private static function sourcesOf(array $configs, array $known, array $groupMembers)
    {
        $attrs = self::attrsByName($known);
        $result = [];
        foreach ($configs as $name => $config) {
            $result[$name] = [];
            foreach (Aggregation::sources($config, $attrs, $groupMembers, $name) as $real => $sources) {
                // A member Icinga doesn't know is kept by name (and left out later)
                $result[$name] = array_merge($result[$name], $sources ?: [$real]);
            }
        }

        return $result;
    }

    /** Add API host results to $known (the first fetch of a host wins) */
    private static function remember(array &$known, array $hosts)
    {
        foreach ($hosts as $host) {
            $name = (string) $host['name'];
            if (! isset($known[$name])) {
                $known[$name] = $host;
            }
        }
    }

    private static function attrsByName(array $known)
    {
        return array_map(function ($host) {
            return $host['attrs'] ?? [];
        }, $known);
    }

    /**
     * API filter for the hosts in any of the groups
     *
     * @param string[] $groups
     *
     * @return array
     */
    public static function inGroups(array $groups)
    {
        if (count($groups) === 1) {
            return ['filter' => 'group in host.groups', 'filter_vars' => ['group' => $groups[0]]];
        }
        $terms = $vars = [];
        foreach ($groups as $i => $group) {
            $terms[] = 'group' . $i . ' in host.groups';
            $vars['group' . $i] = $group;
        }

        return ['filter' => implode(' || ', $terms), 'filter_vars' => $vars];
    }

    private static function names(array $hosts)
    {
        return array_values(array_map(function ($host) {
            return (string) $host['name'];
        }, $hosts));
    }
}
