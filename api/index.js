
const db = require('node-little-db');
//国道列表
function roadList(req, res) {
    const Index = db.use('road-index');
    res.end(JSON.stringify(Index.list));
}

module.exports = {
    roadList,
};