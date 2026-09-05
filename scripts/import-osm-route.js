#!/usr/bin/env node

/*
 * Convert an Overpass `relation + way geometry` response into repository parts.
 * The relation geometry may contain duplicate ways, disconnected components and
 * unordered members, so this importer reconstructs a continuous graph route.
 *
 * Example:
 *   node scripts/import-osm-route.js \
 *     --input /tmp/g320.json --road G320 --relation 288197 \
 *     --output db/G320 --target-km 200
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const EARTH_RADIUS = 6371008.8;

function parseArgs(argv) {
    const result = {};
    for (let i = 2; i < argv.length; i += 1) {
        const argument = argv[i];
        if (!argument.startsWith('--')) {
            throw new Error(`无法识别的参数：${argument}`);
        }
        const key = argument.slice(2);
        if (key === 'allow-straight-gaps' || key === 'update-index' || key === 'graph-only') {
            result[key] = true;
        } else {
            result[key] = argv[i + 1];
            i += 1;
        }
    }
    return result;
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function haversine(first, second) {
    const radians = Math.PI / 180;
    const firstLat = first[1] * radians;
    const secondLat = second[1] * radians;
    const deltaLat = (second[1] - first[1]) * radians;
    const deltaLon = (second[0] - first[0]) * radians;
    const value = Math.sin(deltaLat / 2) ** 2
        + Math.cos(firstLat) * Math.cos(secondLat) * Math.sin(deltaLon / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(value));
}

function lineDistance(coordinates) {
    let distance = 0;
    for (let i = 1; i < coordinates.length; i += 1) {
        distance += haversine(coordinates[i - 1], coordinates[i]);
    }
    return distance;
}

class UnionFind {
    constructor() {
        this.parents = new Map();
    }

    find(value) {
        if (!this.parents.has(value)) {
            this.parents.set(value, value);
        }
        const parent = this.parents.get(value);
        if (parent !== value) {
            this.parents.set(value, this.find(parent));
        }
        return this.parents.get(value);
    }

    union(first, second) {
        const firstRoot = this.find(first);
        const secondRoot = this.find(second);
        if (firstRoot !== secondRoot) {
            this.parents.set(secondRoot, firstRoot);
        }
    }
}

class MinHeap {
    constructor() {
        this.items = [];
    }

    push(item) {
        this.items.push(item);
        let index = this.items.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.items[parent].distance <= item.distance) {
                break;
            }
            this.items[index] = this.items[parent];
            index = parent;
        }
        this.items[index] = item;
    }

    pop() {
        if (this.items.length === 0) {
            return null;
        }
        const first = this.items[0];
        const last = this.items.pop();
        if (this.items.length === 0) {
            return first;
        }
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            if (left >= this.items.length) {
                break;
            }
            let child = left;
            if (right < this.items.length && this.items[right].distance < this.items[left].distance) {
                child = right;
            }
            if (this.items[child].distance >= last.distance) {
                break;
            }
            this.items[index] = this.items[child];
            index = child;
        }
        this.items[index] = last;
        return first;
    }
}

function buildGraph(data) {
    const uniqueWays = new Map();
    data.elements
        .filter(element => element.type === 'way')
        .forEach(way => uniqueWays.set(way.id, way));

    const ways = Array.from(uniqueWays.values()).filter(way => (
        Array.isArray(way.nodes)
        && Array.isArray(way.geometry)
        && way.nodes.length === way.geometry.length
        && way.nodes.length > 1
        && way.tags
        && (typeof way.tags.highway === 'string' || way.tags.route === 'ferry')
    ));
    const unionFind = new UnionFind();
    const nodeCoordinates = new Map();
    const degrees = new Map();
    const adjacency = new Map();

    function addEdge(firstNode, secondNode, edge) {
        if (!adjacency.has(firstNode)) {
            adjacency.set(firstNode, []);
        }
        if (!adjacency.has(secondNode)) {
            adjacency.set(secondNode, []);
        }
        adjacency.get(firstNode).push(Object.assign({ to: secondNode }, edge));
        adjacency.get(secondNode).push(Object.assign({ to: firstNode }, edge));
    }

    ways.forEach(way => {
        way.nodes.forEach((node, index) => {
            const geometry = way.geometry[index];
            nodeCoordinates.set(node, [geometry.lon, geometry.lat]);
        });
        for (let i = 1; i < way.nodes.length; i += 1) {
            const firstNode = way.nodes[i - 1];
            const secondNode = way.nodes[i];
            unionFind.union(firstNode, secondNode);
            degrees.set(firstNode, (degrees.get(firstNode) || 0) + 1);
            degrees.set(secondNode, (degrees.get(secondNode) || 0) + 1);
            addEdge(firstNode, secondNode, {
                kind: 'osm',
                actualDistance: haversine(nodeCoordinates.get(firstNode), nodeCoordinates.get(secondNode)),
                weight: haversine(nodeCoordinates.get(firstNode), nodeCoordinates.get(secondNode)),
                wayId: way.id,
            });
        }
    });

    const componentsByRoot = new Map();
    nodeCoordinates.forEach((coordinate, node) => {
        const root = unionFind.find(node);
        if (!componentsByRoot.has(root)) {
            componentsByRoot.set(root, { root, nodes: [], endpoints: [] });
        }
        const component = componentsByRoot.get(root);
        component.nodes.push(node);
        if (degrees.get(node) === 1) {
            component.endpoints.push(node);
        }
    });
    const components = Array.from(componentsByRoot.values());
    components.forEach(component => {
        if (component.endpoints.length === 0) {
            component.endpoints = component.nodes.slice().sort((first, second) => (
                nodeCoordinates.get(first)[0] - nodeCoordinates.get(second)[0]
            ));
            component.endpoints = [component.endpoints[0], component.endpoints[component.endpoints.length - 1]];
        }
        const byLongitude = component.nodes.slice().sort((first, second) => (
            nodeCoordinates.get(first)[0] - nodeCoordinates.get(second)[0]
        ));
        const byLatitude = component.nodes.slice().sort((first, second) => (
            nodeCoordinates.get(first)[1] - nodeCoordinates.get(second)[1]
        ));
        component.bridgeNodes = Array.from(new Set([
            ...component.endpoints,
            ...byLongitude.slice(0, 8),
            ...byLongitude.slice(-8),
            ...byLatitude.slice(0, 4),
            ...byLatitude.slice(-4),
        ]));
    });

    return {
        adjacency,
        components,
        nodeCoordinates,
        uniqueWayCount: ways.length,
        wayIds: new Set(ways.map(way => way.id)),
        addEdge,
    };
}

function addComponentBridges(graph, maxGapMeters, gapPenalty, gapFixedPenalty) {
    const bridges = [];
    for (let i = 0; i < graph.components.length; i += 1) {
        for (let j = i + 1; j < graph.components.length; j += 1) {
            let nearest = null;
            graph.components[i].bridgeNodes.forEach(firstNode => {
                graph.components[j].bridgeNodes.forEach(secondNode => {
                    const distance = haversine(
                        graph.nodeCoordinates.get(firstNode),
                        graph.nodeCoordinates.get(secondNode),
                    );
                    if (!nearest || distance < nearest.actualDistance) {
                        nearest = { firstNode, secondNode, actualDistance: distance };
                    }
                });
            });
            if (nearest && nearest.actualDistance <= maxGapMeters) {
                const bridge = Object.assign({
                    id: bridges.length + 1,
                    kind: 'bridge',
                    weight: nearest.actualDistance * gapPenalty + gapFixedPenalty,
                }, nearest);
                bridges.push(bridge);
                graph.addEdge(bridge.firstNode, bridge.secondNode, bridge);
            }
        }
    }
    return bridges;
}

function extremeEndpoint(graph, direction) {
    const endpoints = [];
    graph.components.forEach(component => endpoints.push(...component.endpoints));
    return endpoints.reduce((best, node) => {
        if (best === null) {
            return node;
        }
        const longitude = graph.nodeCoordinates.get(node)[0];
        const bestLongitude = graph.nodeCoordinates.get(best)[0];
        return direction === 'east'
            ? (longitude > bestLongitude ? node : best)
            : (longitude < bestLongitude ? node : best);
    }, null);
}

function nearestNode(graph, coordinate) {
    return Array.from(graph.nodeCoordinates.keys()).reduce((best, node) => {
        if (best === null) {
            return node;
        }
        return haversine(graph.nodeCoordinates.get(node), coordinate)
            < haversine(graph.nodeCoordinates.get(best), coordinate) ? node : best;
    }, null);
}

function parseCoordinate(value, label) {
    if (!value) {
        return null;
    }
    const coordinate = value.split(',').map(Number);
    if (coordinate.length !== 2 || coordinate.some(item => !Number.isFinite(item))) {
        throw new Error(`${label} 必须为“经度,纬度”`);
    }
    return coordinate;
}

function parseCoordinateList(value, label) {
    if (!value) {
        return [];
    }
    return value.split(';')
        .filter(item => item.trim())
        .map((item, index) => parseCoordinate(item.trim(), `${label} 第 ${index + 1} 项`));
}

function shortestPath(graph, start, finish) {
    const distances = new Map([[start, 0]]);
    const previous = new Map();
    const heap = new MinHeap();
    heap.push({ node: start, distance: 0 });

    while (heap.items.length > 0) {
        const current = heap.pop();
        if (current.distance !== distances.get(current.node)) {
            continue;
        }
        if (current.node === finish) {
            break;
        }
        (graph.adjacency.get(current.node) || []).forEach(edge => {
            const candidate = current.distance + edge.weight;
            if (!distances.has(edge.to) || candidate < distances.get(edge.to)) {
                distances.set(edge.to, candidate);
                previous.set(edge.to, { node: current.node, edge });
                heap.push({ node: edge.to, distance: candidate });
            }
        });
    }

    if (!previous.has(finish)) {
        throw new Error('无法在起点与终点之间重建连续路线，请提高 --max-gap-km 后重试');
    }
    const steps = [];
    let node = finish;
    while (node !== start) {
        const item = previous.get(node);
        steps.push({ from: item.node, to: node, edge: item.edge });
        node = item.node;
    }
    return steps.reverse();
}

function repeatedTraversalDistance(steps) {
    const traversedEdges = new Set();
    return steps.reduce((distance, step) => {
        const edgeKey = step.from < step.to
            ? `${step.from}:${step.to}`
            : `${step.to}:${step.from}`;
        if (traversedEdges.has(edgeKey)) {
            return distance + step.edge.actualDistance;
        }
        traversedEdges.add(edgeKey);
        return distance;
    }, 0);
}

function requestJson(url, redirects) {
    const redirectCount = redirects || 0;
    return new Promise((resolve, reject) => {
        const transport = url.startsWith('https:') ? https : http;
        const request = transport.get(url, {
            headers: { 'User-Agent': 'china-national-highway-importer/1.0' },
        }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirectCount >= 5) {
                    reject(new Error('OSRM 重定向次数过多'));
                    return;
                }
                resolve(requestJson(new URL(response.headers.location, url).toString(), redirectCount + 1));
                return;
            }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                if (response.statusCode !== 200) {
                    reject(new Error(`OSRM HTTP ${response.statusCode}: ${body.slice(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`OSRM 返回了非 JSON 内容：${body.slice(0, 200)}`));
                }
            });
        });
        request.setTimeout(30000, () => request.destroy(new Error('OSRM 请求超时')));
        request.on('error', reject);
    });
}

async function osrmRoute(first, second, baseUrl) {
    const coordinates = `${first[0].toFixed(7)},${first[1].toFixed(7)};${second[0].toFixed(7)},${second[1].toFixed(7)}`;
    const url = `${baseUrl.replace(/\/$/, '')}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            const data = await requestJson(url);
            if (data.code !== 'Ok' || !data.routes || !data.routes[0]) {
                throw new Error(`OSRM 路线规划失败：${data.code || 'unknown'}`);
            }
            return {
                coordinates: data.routes[0].geometry.coordinates,
                distance: data.routes[0].distance,
            };
        } catch (error) {
            lastError = error;
            await sleep(1000 * (attempt + 1));
        }
    }
    throw lastError;
}

function appendCoordinates(target, coordinates) {
    coordinates.forEach(coordinate => {
        const previous = target[target.length - 1];
        if (!previous || haversine(previous, coordinate) > 0.05) {
            target.push(coordinate);
        }
    });
}

async function materializePath(graph, steps, options) {
    const coordinates = [graph.nodeCoordinates.get(steps[0].from)];
    const usedBridges = [];
    for (const step of steps) {
        const finish = graph.nodeCoordinates.get(step.to);
        if (step.edge.kind === 'osm') {
            appendCoordinates(coordinates, [finish]);
            continue;
        }
        const start = graph.nodeCoordinates.get(step.from);
        let route;
        let mode = 'osrm';
        try {
            route = await osrmRoute(start, finish, options.osrmUrl);
            const maximumRouteDistance = Math.max(
                step.edge.actualDistance * options.maxBridgeDetourRatio,
                step.edge.actualDistance + options.maxBridgeDetourExtra,
            );
            if (route.distance > maximumRouteDistance) {
                throw new Error(`OSRM 绕行过长：${Math.round(route.distance / 1000)} km`);
            }
        } catch (error) {
            if (!options.allowStraightGaps) {
                throw new Error(`缺口 ${step.edge.id} 补线失败：${error.message}`);
            }
            route = { coordinates: [start, finish], distance: step.edge.actualDistance };
            mode = 'straight';
        }
        appendCoordinates(coordinates, route.coordinates);
        appendCoordinates(coordinates, [finish]);
        usedBridges.push({
            id: step.edge.id,
            leg: step.leg,
            from: start,
            to: finish,
            straightDistance: Math.round(step.edge.actualDistance),
            routeDistance: Math.round(route.distance),
            mode,
        });
        if (options.osrmDelay > 0) {
            await sleep(options.osrmDelay);
        }
    }
    return { coordinates, usedBridges };
}

function transformLat(x, y) {
    let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    value += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    value += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return value;
}

function transformLon(x, y) {
    let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    value += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    value += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return value;
}

function wgs84ToGcj02(coordinate) {
    const longitude = coordinate[0];
    const latitude = coordinate[1];
    if (longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271) {
        return coordinate.slice();
    }
    const axis = 6378245;
    const eccentricity = 0.006693421622965943;
    let deltaLat = transformLat(longitude - 105, latitude - 35);
    let deltaLon = transformLon(longitude - 105, latitude - 35);
    const radLat = latitude / 180 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - eccentricity * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    deltaLat = (deltaLat * 180) / ((axis * (1 - eccentricity)) / (magic * sqrtMagic) * Math.PI);
    deltaLon = (deltaLon * 180) / (axis / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [longitude + deltaLon, latitude + deltaLat];
}

function splitLine(coordinates, targetDistance) {
    const totalDistance = lineDistance(coordinates);
    const partCount = Math.max(1, Math.round(totalDistance / targetDistance));
    const balancedDistance = totalDistance / partCount;
    const parts = [];
    let current = [coordinates[0]];
    let currentDistance = 0;
    for (let i = 1; i < coordinates.length; i += 1) {
        let start = coordinates[i - 1];
        const finish = coordinates[i];
        let remaining = haversine(start, finish);
        while (parts.length < partCount - 1 && currentDistance + remaining > balancedDistance) {
            const needed = balancedDistance - currentDistance;
            const ratio = needed / remaining;
            const split = [
                start[0] + (finish[0] - start[0]) * ratio,
                start[1] + (finish[1] - start[1]) * ratio,
            ];
            current.push(split);
            parts.push(current);
            current = [split];
            start = split;
            remaining = haversine(start, finish);
            currentDistance = 0;
        }
        current.push(finish);
        currentDistance += remaining;
    }
    if (current.length > 1) {
        parts.push(current);
    }
    return parts;
}

function validateParts(parts, targetDistance) {
    if (parts.length === 0) {
        throw new Error('切分结果为空');
    }
    let previousFinish = null;
    let maximumPartDistance = 0;
    let maximumPartGap = 0;
    parts.forEach((coordinates, index) => {
        if (!Array.isArray(coordinates) || coordinates.length < 2) {
            throw new Error(`第 ${index + 1} 段坐标点不足`);
        }
        coordinates.forEach(coordinate => {
            if (!Array.isArray(coordinate)
                || coordinate.length !== 2
                || !Number.isFinite(coordinate[0])
                || !Number.isFinite(coordinate[1])) {
                throw new Error(`第 ${index + 1} 段包含无效坐标`);
            }
        });
        const distance = lineDistance(coordinates);
        maximumPartDistance = Math.max(maximumPartDistance, distance);
        if (distance > targetDistance * 1.5) {
            throw new Error(`第 ${index + 1} 段显著超过目标长度：${Math.round(distance)} m`);
        }
        if (previousFinish) {
            maximumPartGap = Math.max(maximumPartGap, haversine(previousFinish, coordinates[0]));
        }
        previousFinish = coordinates[coordinates.length - 1];
    });
    if (maximumPartGap > 0.1) {
        throw new Error(`相邻分段不连续，最大间隙 ${maximumPartGap.toFixed(3)} m`);
    }
    return {
        jsonSchema: 'passed',
        coordinateSystem: 'GCJ-02',
        maximumPartDistance: Math.round(maximumPartDistance),
        maximumAdjacentPartGap: maximumPartGap,
    };
}

function writeOutput(parts, options, provenance, report) {
    if (fs.existsSync(options.output) && fs.readdirSync(options.output).length > 0) {
        throw new Error(`输出目录非空，拒绝覆盖：${options.output}`);
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `${options.road}-parts-`));
    parts.forEach((coordinates, partIndex) => {
        const index = String(partIndex + 1);
        const feature = {
            type: 'Feature',
            geometry: { type: 'Polyline', coordinates },
            properties: {
                index,
                description: `${options.from}—${options.to}（OSM）第${index}段`,
                road: options.road,
                distance: Math.round(lineDistance(coordinates)),
                status: 1,
                source: '© OpenStreetMap contributors',
                sourceUrl: `https://www.openstreetmap.org/relation/${options.relation}`,
                sourceLicense: 'ODbL 1.0',
                sourceTimestamp: provenance.timestamp,
            },
        };
        fs.writeFileSync(
            path.join(temporary, `${options.road}-part-${index}.json`),
            `${JSON.stringify(feature, null, 2)}\n`,
        );
    });
    if (fs.existsSync(options.output)) {
        fs.rmdirSync(options.output);
    } else {
        fs.mkdirSync(path.dirname(options.output), { recursive: true });
    }
    fs.renameSync(temporary, options.output);
    fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
}

function updateRoadIndex(road, indexPath) {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const item = data.list.find(entry => entry.name === road);
    if (!item) {
        throw new Error(`${indexPath} 中不存在 ${road}`);
    }
    item.status = 1;
    const temporary = `${indexPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(temporary, indexPath);
}

async function main() {
    const args = parseArgs(process.argv);
    if (!args.input) {
        throw new Error('必须提供 --input（Overpass relation + way geometry JSON）');
    }
    const options = {
        input: path.resolve(args.input),
        road: args.road || 'G320',
        relation: Number(args.relation || 288197),
        output: path.resolve(args.output || 'db/G320'),
        report: path.resolve(args.report || 'db/G320-import-report.json'),
        targetDistance: Number(args['target-km'] || 200) * 1000,
        maxGapDistance: Number(args['max-gap-km'] || 80) * 1000,
        gapPenalty: Number(args['gap-penalty'] || 20),
        gapFixedPenalty: Number(args['gap-fixed-km'] || 1) * 1000,
        osrmUrl: args['osrm-url'] || 'https://router.project-osrm.org',
        osrmDelay: Number(args['osrm-delay-ms'] || 1000),
        maxBridgeDetourRatio: Number(args['max-bridge-detour-ratio'] || 4),
        maxBridgeDetourExtra: Number(args['max-bridge-detour-extra-km'] || 30) * 1000,
        allowStraightGaps: Boolean(args['allow-straight-gaps']),
        from: args.from || '上海',
        to: args.to || '瑞丽',
        updateIndex: Boolean(args['update-index']),
        startCoordinate: parseCoordinate(args.start, '--start'),
        finishCoordinate: parseCoordinate(args.finish, '--finish'),
        viaCoordinates: parseCoordinateList(args.via, '--via'),
    };
    const inputBuffer = fs.readFileSync(options.input);
    const data = JSON.parse(inputBuffer.toString('utf8'));
    const relation = data.elements.find(element => element.type === 'relation' && element.id === options.relation);
    if (!relation) {
        throw new Error(`输入中不存在 relation ${options.relation}`);
    }
    const relationWayIds = new Set(
        relation.members.filter(member => member.type === 'way').map(member => member.ref),
    );

    const graph = buildGraph(data);
    addComponentBridges(graph, options.maxGapDistance, options.gapPenalty, options.gapFixedPenalty);
    const start = options.startCoordinate
        ? nearestNode(graph, options.startCoordinate)
        : extremeEndpoint(graph, 'east');
    const finish = options.finishCoordinate
        ? nearestNode(graph, options.finishCoordinate)
        : extremeEndpoint(graph, 'west');
    const routeNodes = [
        start,
        ...options.viaCoordinates.map(coordinate => nearestNode(graph, coordinate)),
        finish,
    ].filter((node, index, nodes) => index === 0 || node !== nodes[index - 1]);
    const steps = [];
    for (let index = 1; index < routeNodes.length; index += 1) {
        const legSteps = shortestPath(graph, routeNodes[index - 1], routeNodes[index]);
        legSteps.forEach(step => { step.leg = index; });
        steps.push(...legSteps);
    }
    const wayById = new Map(
        data.elements.filter(element => element.type === 'way').map(way => [way.id, way]),
    );
    const selectedOsmWayIds = new Set(
        steps.filter(step => step.edge.kind === 'osm').map(step => step.edge.wayId),
    );
    const selectedWays = Array.from(selectedOsmWayIds).map(wayId => wayById.get(wayId));
    const selectedWayQuality = {
        uniqueWays: selectedOsmWayIds.size,
        supplementalWays: Array.from(selectedOsmWayIds)
            .filter(wayId => !relationWayIds.has(wayId)).length,
        constructionWays: selectedWays
            .filter(way => way && way.tags && way.tags.highway === 'construction').length,
        proposedWays: selectedWays
            .filter(way => way && way.tags && way.tags.highway === 'proposed').length,
        nonRoadWayIds: selectedWays
            .filter(way => !way || !way.tags || !way.tags.highway)
            .map(way => (way ? way.id : null)),
    };
    if (args['graph-only']) {
        const bridgeSteps = steps.filter(step => step.edge.kind === 'bridge').map(step => ({
            id: step.edge.id,
            leg: step.leg,
            from: graph.nodeCoordinates.get(step.from),
            to: graph.nodeCoordinates.get(step.to),
            straightDistance: Math.round(step.edge.actualDistance),
        }));
        const repeatedEdgeDistance = repeatedTraversalDistance(steps);
        process.stdout.write(`${JSON.stringify({
            components: graph.components.length,
            selectedEdges: steps.length,
            routeNodes: routeNodes.map(node => graph.nodeCoordinates.get(node)),
            graphDistance: Math.round(steps.reduce((sum, step) => sum + step.edge.actualDistance, 0)),
            repeatedEdgeDistance: Math.round(repeatedEdgeDistance),
            selectedWayQuality,
            bridges: bridgeSteps,
            totalGapDistance: bridgeSteps.reduce((sum, bridge) => sum + bridge.straightDistance, 0),
        }, null, 2)}\n`);
        return;
    }
    const materialized = await materializePath(graph, steps, options);
    const gcjCoordinates = materialized.coordinates.map(wgs84ToGcj02);
    const parts = splitLine(gcjCoordinates, options.targetDistance);
    const validation = validateParts(parts, options.targetDistance);
    const sourceTimestamp = data.osm3s && data.osm3s.timestamp_osm_base
        ? data.osm3s.timestamp_osm_base
        : null;
    const provenance = { timestamp: sourceTimestamp };
    const distances = parts.map(lineDistance);
    const activeRelationWays = Array.from(graph.wayIds)
        .filter(wayId => relationWayIds.has(wayId)).length;
    const bridgeWarnings = materialized.usedBridges
        .filter(bridge => (
            bridge.straightDistance >= 100000
            || (bridge.straightDistance > 1000
                && bridge.routeDistance / bridge.straightDistance > 8)
        ))
        .map(bridge => ({
            id: bridge.id,
            straightDistance: bridge.straightDistance,
            routeDistance: bridge.routeDistance,
            reason: bridge.straightDistance >= 100000
                ? 'large-topology-gap'
                : 'large-routing-detour',
        }));
    const report = {
        road: options.road,
        relation: options.relation,
        source: '© OpenStreetMap contributors',
        sourceLicense: 'ODbL 1.0',
        sourceTimestamp,
        inputSha256: crypto.createHash('sha256').update(inputBuffer).digest('hex'),
        uniqueWays: graph.uniqueWayCount,
        uniqueRelationWays: relationWayIds.size,
        activeRelationWays,
        supplementalWays: Math.max(0, graph.uniqueWayCount - activeRelationWays),
        topologyComponents: graph.components.length,
        selectedGraphEdges: steps.length,
        selectedGraphDistance: Math.round(
            steps.reduce((sum, step) => sum + step.edge.actualDistance, 0),
        ),
        repeatedGraphEdgeDistance: Math.round(repeatedTraversalDistance(steps)),
        selectedWayQuality,
        bridges: materialized.usedBridges,
        bridgeRoutingPolicy: {
            maximumDetourRatio: options.maxBridgeDetourRatio,
            maximumExtraDistance: options.maxBridgeDetourExtra,
            straightFallbackAllowed: options.allowStraightGaps,
        },
        bridgeWarnings,
        coordinateSystem: 'GCJ-02',
        partCount: parts.length,
        targetPartDistance: options.targetDistance,
        averagePartDistance: Math.round(
            distances.reduce((sum, value) => sum + value, 0) / distances.length,
        ),
        totalDistance: Math.round(distances.reduce((sum, value) => sum + value, 0)),
        minimumPartDistance: Math.round(Math.min(...distances)),
        maximumPartDistance: Math.round(Math.max(...distances)),
        startWgs84: graph.nodeCoordinates.get(start),
        finishWgs84: graph.nodeCoordinates.get(finish),
        viaWgs84: routeNodes.slice(1, -1).map(node => graph.nodeCoordinates.get(node)),
        startGcj02: gcjCoordinates[0],
        finishGcj02: gcjCoordinates[gcjCoordinates.length - 1],
        validation,
    };

    writeOutput(parts, options, provenance, report);
    if (options.updateIndex) {
        updateRoadIndex(options.road, path.resolve('db/road-index.json'));
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`导入失败：${error.message}\n`);
    process.exitCode = 1;
});
