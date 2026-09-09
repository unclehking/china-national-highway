const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 校验页面实际方法；不加载浏览器依赖，也不发送排序保存请求。
const html = fs.readFileSync(path.join(__dirname, '../collect/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
let options;
function Vue(config) {
    options = config;
}
Vue.use = () => {};
class Sortable {
    constructor(element, config) {
        this.config = config;
        this.destroyed = false;
    }
    option(name, value) {
        this.config[name] = value;
    }
    destroy() {
        this.destroyed = true;
    }
}
vm.runInNewContext(scripts[scripts.length - 1][1], {
    Vue,
    VueQuillEditor: {},
    Sortable,
    location: { hash: '' },
    document: { querySelector: () => ({}) },
    fetch() {
        throw new Error('名称排序不应发送网络请求');
    }
}, { filename: 'collect/index.html' });

const app = options.data();
Object.entries(options.methods).forEach(([name, method]) => {
    app[name] = method.bind(app);
});
let saveCount = 0;
app.loadRoadPaths = () => {};
app.batchUpdateIndex = () => { saveCount += 1; };
options.mounted.call(app);
const rows = ['G331', 'G10', 'G2', 'G108', 'G1000', 'G228'].map((name, index) => ({ name, index }));
app.tableData = rows.slice();
const snapshot = JSON.stringify(app.tableData);
let passed = 0;
function test(name, run) {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
}

test('名称列绑定本地排序、比较器和三态切换', () => {
    assert.match(html, /prop="name"[^>]*\bsortable\s+:sort-method="compareRoadNames"/);
    assert.ok(html.includes(':sort-orders="[\'ascending\', \'descending\', null]"'));
    assert.ok(html.includes('@sort-change="handleSortChange"'));
});
test('按国道数字编号升序、降序排列', () => {
    const ascending = rows.slice().sort(app.compareRoadNames).map(row => row.name);
    const descending = rows.slice().sort((a, b) => -app.compareRoadNames(a, b)).map(row => row.name);
    assert.deepEqual(ascending, ['G2', 'G10', 'G108', 'G228', 'G331', 'G1000']);
    assert.deepEqual(descending, ascending.slice().reverse());
    assert.equal(app.compareRoadNames({ name: 'G108' }, { name: 'G108' }), 0);
    assert.equal(app.compareRoadNames({ name: 'g108' }, { name: 'G108' }), 0);
});
test('空列表及缺失名称不会导致比较器报错', () => {
    assert.deepEqual([].sort(app.compareRoadNames), []);
    assert.equal(app.compareRoadNames({}, { name: null }), 0);
    assert.ok(Number.isFinite(app.compareRoadNames({}, { name: 'G108' })));
});
test('升序和降序都禁用拖动，不修改原始数据或保存序号', () => {
    ['ascending', 'descending'].forEach(order => {
        app.handleSortChange({ prop: 'name', order });
        assert.equal(app.nameSortOrder, order);
        assert.equal(app.rowSortable.config.disabled, true);
        app.rowSortable.config.onEnd({ oldIndex: 0, newIndex: 2 });
        assert.equal(JSON.stringify(app.tableData), snapshot);
        assert.equal(saveCount, 0);
    });
});
test('取消名称排序恢复拖动，原始顺序保持不变', () => {
    app.handleSortChange({ prop: 'name', order: null });
    assert.equal(app.nameSortOrder, null);
    assert.equal(app.rowSortable.config.disabled, false);
    assert.equal(JSON.stringify(app.tableData), snapshot);
});
test('恢复后拖动仍可更新原始顺序，原地拖动不保存', () => {
    app.rowSortable.config.onEnd({ oldIndex: 0, newIndex: 0 });
    assert.equal(saveCount, 0);
    app.rowSortable.config.onEnd({ oldIndex: 0, newIndex: 2 });
    assert.deepEqual(app.tableData.map(row => row.name), ['G10', 'G2', 'G331', 'G108', 'G1000', 'G228']);
    assert.equal(saveCount, 1);
});
test('排序状态早于拖动组件初始化时也能禁用拖动', () => {
    const sortable = app.rowSortable;
    app.rowSortable = null;
    app.handleSortChange({ prop: 'name', order: 'ascending' });
    options.mounted.call(app);
    assert.equal(app.rowSortable.config.disabled, true);
    sortable.destroy();
});
test('组件销毁时释放拖动实例', () => {
    const sortable = app.rowSortable;
    options.beforeDestroy.call(app);
    assert.equal(sortable.destroyed, true);
    app.rowSortable = null;
    options.beforeDestroy.call(app);
});
console.log(`\n${passed}/${passed} road name sort tests passed`);
