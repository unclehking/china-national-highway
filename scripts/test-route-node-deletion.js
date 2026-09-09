const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Run the actual page methods without loading Vue, AMap, or sending HTTP requests.
const page = fs.readFileSync(path.join(__dirname, '../collect/edit.html'), 'utf8');
const inlineScripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1]));
assert.ok(inlineScripts.length, 'The edit page must contain its Vue application script');
const appScript = inlineScripts[inlineScripts.length - 1][2];
const initialPath = [[10, 20], [40, 20], [70, 20], [100, 20]];
const editorEvents = ['addnode', 'adjust', 'removenode'];
const tests = [];

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function lineDistance(coordinates) {
    return coordinates.slice(1).reduce((distance, point, index) => {
        const previous = coordinates[index];
        return distance + Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    }, 0);
}

function createHarness(coordinates = initialPath, dimensions = {}) {
    const fetchCalls = [];
    const messages = [];
    const editors = [];
    let options;

    class LngLat {
        constructor(lng, lat) {
            this.lng = lng;
            this.lat = lat;
        }
    }

    class Polyline {
        constructor(config) {
            this.setPath(config.path);
        }

        setPath(points) {
            this.points = points.map(point => Array.isArray(point)
                ? new LngLat(point[0], point[1])
                : new LngLat(point.lng, point.lat));
        }

        getPath() {
            return this.points;
        }
    }

    class PolylineEditor {
        constructor(map, target) {
            this.map = map;
            this.target = target;
            this.listeners = new Map();
            this.openCount = 0;
            this.closeCount = 0;
            this.targets = [];
            editors.push(this);
        }

        on(name, handler) {
            const handlers = this.listeners.get(name) || [];
            handlers.push(handler);
            this.listeners.set(name, handlers);
        }

        off(name, handler) {
            this.listeners.set(name, (this.listeners.get(name) || [])
                .filter(existing => existing !== handler));
        }

        emit(name) {
            (this.listeners.get(name) || []).slice().forEach(handler => handler({ target: this.target }));
        }

        setTarget(target) {
            this.target = target;
            this.targets.push(target);
        }

        open() {
            this.openCount += 1;
        }

        close() {
            this.closeCount += 1;
        }
    }

    class Marker {
        setPosition(position) {
            this.position = plain(position);
        }
    }

    const map = {
        added: [],
        removed: [],
        fitCount: 0,
        destroyed: false,
        projectionScale: dimensions.projectionScale || 1,
        add(overlay) {
            this.added.push(overlay);
        },
        remove(overlay) {
            this.removed.push(overlay);
        },
        setFitView() {
            this.fitCount += 1;
        },
        lngLatToContainer(point) {
            return {
                getX: () => point[0] * this.projectionScale,
                getY: () => point[1] * this.projectionScale
            };
        },
        destroy() {
            this.destroyed = true;
        }
    };
    const rect = {
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        ...dimensions.rect
    };
    const container = {
        clientWidth: dimensions.clientWidth || 800,
        clientHeight: dimensions.clientHeight || 600,
        getBoundingClientRect: () => rect
    };
    const message = entry => messages.push(entry);
    ['warning', 'success', 'error'].forEach(type => {
        message[type] = text => messages.push({ type, message: text });
    });
    const context = vm.createContext({
        Vue: function(config) {
            options = config;
        },
        AMap: { LngLat, Polyline, PolylineEditor, Marker, GeometryUtil: { distanceOfLine: lineDistance } },
        fetch: async (...args) => {
            fetchCalls.push(args);
            return { json: async () => ({ success: true }) };
        },
        console: { log() {}, error() {} },
        setTimeout() {},
        window: { close() {} },
        URLSearchParams
    });
    vm.runInContext(appScript, context, { filename: 'collect/edit.html' });
    assert.ok(options && options.methods, 'Vue options must be captured');
    const app = Object.assign(options.data(), {
        map,
        $refs: { mapContainer: container },
        $message: message,
        startMarker: new Marker(),
        endMarker: new Marker()
    });
    Object.entries(options.methods).forEach(([name, method]) => {
        app[name] = method.bind(app);
    });
    app.drawPath(plain(coordinates));

    function pointerAt(point, overrides = {}) {
        return {
            button: 2,
            ctrlKey: false,
            clientX: rect.left + point[0] * map.projectionScale * rect.width / container.clientWidth,
            clientY: rect.top + point[1] * map.projectionScale * rect.height / container.clientHeight,
            prevented: false,
            stopped: false,
            preventDefault() {
                this.prevented = true;
            },
            stopImmediatePropagation() {
                this.stopped = true;
            },
            ...overrides
        };
    }

    function expectPath(expected) {
        assert.deepEqual(plain(app.getPathCoordinates()), expected);
        assert.deepEqual(plain(app.pathCoordinates), expected);
        assert.equal(app.distance, Math.round(lineDistance(expected)));
        assert.equal(app.form.firstPosition, expected[0].join(','));
        assert.equal(app.form.lastPosition, expected[expected.length - 1].join(','));
        assert.deepEqual(app.startMarker.position, expected[0]);
        assert.deepEqual(app.endMarker.position, expected[expected.length - 1]);
    }

    return { app, options, map, editors, messages, fetchCalls, pointerAt, expectPath };
}

function test(name, run) {
    tests.push({ name, run });
}

test('map container captures context menus and editor right-button events', () => {
    assert.match(page, /@contextmenu\.capture="removeNodeAtPointer"/);
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick'].forEach(event => {
        assert.ok(page.includes(`@${event}.capture="stopEditorRightClick"`));
    });
});

test('right-click removes only the middle node and synchronizes all route state', () => {
    const harness = createHarness();
    const event = harness.pointerAt(initialPath[1]);
    harness.app.removeNodeAtPointer(event);
    harness.expectPath([initialPath[0], initialPath[2], initialPath[3]]);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.equal(harness.messages[0].type, 'success');
    assert.match(harness.messages[0].message, /保存/);
    assert.equal(harness.fetchCalls.length, 0, 'Deletion must remain an unsaved local edit');
    assert.equal(harness.map.fitCount, 1, 'Deleting must preserve the current map view');
});

test('first and last nodes can be deleted and endpoint markers follow the new path', () => {
    [0, initialPath.length - 1].forEach(index => {
        const harness = createHarness();
        harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[index]));
        harness.expectPath(initialPath.filter((point, pointIndex) => pointIndex !== index));
    });
});

test('two remaining nodes cannot be deleted', () => {
    const coordinates = initialPath.slice(0, 2);
    const harness = createHarness(coordinates);
    harness.app.removeNodeAtPointer(harness.pointerAt(coordinates[0]));
    harness.expectPath(coordinates);
    assert.match(harness.messages[0].message, /至少.*2/);
    assert.equal(harness.editors[0].closeCount, 0);
    assert.equal(harness.fetchCalls.length, 0);
});

test('blank map space and segment midpoints never delete a node', () => {
    const harness = createHarness();
    [[300, 300], [25, 20]].forEach(point => {
        harness.app.removeNodeAtPointer(harness.pointerAt(point));
        harness.expectPath(initialPath);
    });
    assert.equal(harness.messages.length, 0);
});

test('ambiguous dense nodes ask the user to zoom in', () => {
    const coordinates = [[10, 20], [40, 20], [41, 20], [100, 20]];
    const harness = createHarness(coordinates);
    harness.app.removeNodeAtPointer(harness.pointerAt([40, 20]));
    harness.expectPath(coordinates);
    assert.match(harness.messages[0].message, /密集.*放大/);
    harness.map.projectionScale = 4;
    harness.app.removeNodeAtPointer(harness.pointerAt([40, 20]));
    harness.expectPath([coordinates[0], coordinates[2], coordinates[3]]);
});

test('hit testing accounts for container offsets, CSS scaling, and map projection', () => {
    const harness = createHarness(initialPath, {
        rect: { left: 137, top: 83, width: 400, height: 900 },
        clientWidth: 800,
        clientHeight: 600,
        projectionScale: 2
    });
    harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[2]));
    harness.expectPath([initialPath[0], initialPath[1], initialPath[3]]);
});

test('hit testing uses a bounded pixel radius around actual nodes', () => {
    const harness = createHarness();
    harness.app.removeNodeAtPointer(harness.pointerAt([40, 29]));
    harness.expectPath(initialPath);
    harness.app.removeNodeAtPointer(harness.pointerAt([40, 27]));
    harness.expectPath([initialPath[0], initialPath[2], initialPath[3]]);
});

test('right-button propagation is stopped before the editor can delete again', () => {
    const harness = createHarness();
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick']) {
        const event = harness.pointerAt(initialPath[1], { type });
        harness.app.stopEditorRightClick(event);
        assert.equal(event.stopped, true, type);
        assert.equal(event.prevented, false, 'The browser must still deliver the contextmenu event');
        harness.expectPath(initialPath);
    }
    harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[1]));
    harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[1]));
    harness.expectPath([initialPath[0], initialPath[2], initialPath[3]]);
    harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[2]));
    harness.expectPath([initialPath[0], initialPath[3]]);
    assert.equal(harness.messages.filter(message => message.type === 'success').length, 2);
    assert.equal(harness.fetchCalls.length, 0);
});

test('Control-click deletes once while ordinary left-click remains available to the editor', () => {
    const harness = createHarness();
    const leftClick = harness.pointerAt(initialPath[1], { button: 0 });
    harness.app.stopEditorRightClick(leftClick);
    assert.equal(leftClick.stopped, false);
    const controlClick = harness.pointerAt(initialPath[1], { button: 0, ctrlKey: true });
    harness.app.stopEditorRightClick(controlClick);
    assert.equal(controlClick.stopped, true);
    harness.expectPath(initialPath);
    harness.app.removeNodeAtPointer(controlClick);
    harness.expectPath([initialPath[0], initialPath[2], initialPath[3]]);
});

test('keyboard context menus cannot delete nodes', () => {
    const harness = createHarness();
    harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[1], { button: 0, detail: 0 }));
    harness.expectPath(initialPath);
    assert.equal(harness.messages.length, 0);
});

test('editor drag, add, and native remove events synchronize coordinates, distance, and markers', () => {
    const harness = createHarness();
    const changes = [
        ['adjust', [[5, 15], [40, 30], [70, 20], [105, 25]]],
        ['addnode', [[5, 15], [25, 30], [40, 30], [70, 20], [105, 25]]],
        ['removenode', [[5, 15], [25, 30], [70, 20], [105, 25]]]
    ];
    changes.forEach(([event, coordinates]) => {
        harness.app.editablePolyline.setPath(coordinates);
        harness.app.polyEditor.emit(event);
        harness.expectPath(coordinates);
    });
    harness.app.removeNodeAtPointer(harness.pointerAt([25, 30]));
    harness.expectPath([[5, 15], [70, 20], [105, 25]]);
    assert.equal(harness.fetchCalls.length, 0);
});

test('native editor deletion below two points restores the last valid path', () => {
    const coordinates = initialPath.slice(0, 2);
    const harness = createHarness(coordinates);
    harness.app.editablePolyline.setPath([coordinates[0]]);
    harness.app.polyEditor.emit('removenode');
    harness.expectPath(coordinates);
    assert.match(harness.messages[0].message, /至少.*2/);
    assert.equal(harness.app.polyEditor.target, harness.app.editablePolyline);
    assert.equal(harness.app.polyEditor.openCount, 2);
    assert.equal(harness.fetchCalls.length, 0);
});

test('invalid submit never sends deletion or save requests', async () => {
    for (const invalidPath of [[], [initialPath[0]]]) {
        const harness = createHarness();
        harness.app.form._id = 'G318-part-1.json';
        harness.app.editablePolyline.setPath(invalidPath);
        await harness.app.submit();
        assert.equal(harness.fetchCalls.length, 0);
        assert.match(harness.messages[0].message, /至少.*2/);
    }
});

test('explicit save sends the current edited path and recalculated distance', async () => {
    const harness = createHarness();
    Object.assign(harness.app.form, { _id: 'G228-part-34', name: 'G228', index: 34 });
    harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[1]));
    assert.equal(harness.fetchCalls.length, 0);
    await harness.app.submit();
    assert.equal(harness.fetchCalls.length, 2);
    assert.equal(harness.fetchCalls[0][0], '/api/removeRoadPart?partName=G228-part-34');
    const [url, request] = harness.fetchCalls[1];
    assert.equal(url, '/api/addPath');
    assert.equal(request.method, 'POST');
    const saved = JSON.parse(request.body);
    const expected = [initialPath[0], initialPath[2], initialPath[3]];
    assert.deepEqual(saved.coordinates, expected);
    assert.equal(saved.distance, Math.round(lineDistance(expected)));
    assert.equal(saved.road, 'G228');
    assert.equal(saved.index, 34);
});

test('reopening the editor does not accumulate event listeners', () => {
    const harness = createHarness();
    const originalEditor = harness.app.polyEditor;
    harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[1]));
    harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[2]));
    assert.equal(harness.app.polyEditor, originalEditor);
    editorEvents.forEach(event => assert.equal(originalEditor.listeners.get(event).length, 1));
    assert.equal(originalEditor.closeCount, 2);
    assert.equal(originalEditor.openCount, 3);
    assert.equal(originalEditor.target, harness.app.editablePolyline);
    assert.ok(originalEditor.targets.includes(undefined), 'Reopening must release the previous editor target');
    const oldPolyline = harness.app.editablePolyline;
    harness.app.drawPath(initialPath);
    assert.notEqual(harness.app.polyEditor, originalEditor);
    editorEvents.forEach(event => {
        assert.equal(originalEditor.listeners.get(event).length, 0);
        assert.equal(harness.app.polyEditor.listeners.get(event).length, 1);
    });
    assert.equal(originalEditor.target, undefined);
    assert.ok(harness.map.removed.includes(oldPolyline));
    originalEditor.emit('removenode');
    harness.expectPath(initialPath);
});

test('closing and destroying release editor bindings and ignore subsequent node deletion', () => {
    const harness = createHarness();
    const editor = harness.app.polyEditor;
    harness.app.closeEditor();
    harness.app.closeEditor();
    assert.equal(harness.app.polyEditor, null);
    assert.equal(editor.closeCount, 1);
    editorEvents.forEach(event => assert.equal(editor.listeners.get(event).length, 0));
    harness.app.removeNodeAtPointer(harness.pointerAt(initialPath[1]));
    harness.expectPath(initialPath);
    harness.app.drawPath(initialPath);
    const reopened = harness.app.polyEditor;
    harness.options.beforeDestroy.call(harness.app);
    assert.equal(harness.app.polyEditor, null);
    assert.equal(reopened.closeCount, 1);
    editorEvents.forEach(event => assert.equal(reopened.listeners.get(event).length, 0));
    assert.equal(harness.map.destroyed, true);
    assert.equal(harness.fetchCalls.length, 0);
});

(async () => {
    let failures = 0;
    for (const { name, run } of tests) {
        try {
            await run();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures += 1;
            console.error(`FAIL ${name}`);
            console.error(error);
        }
    }
    console.log(`\n${tests.length - failures}/${tests.length} route node deletion tests passed`);
    process.exitCode = failures ? 1 : 0;
})();
