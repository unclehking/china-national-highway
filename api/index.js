
const db = require('node-little-db');
function roadList(req, res) {
    const Index = db.use('road-index');
    
    console.log(Index, 55555);
    
    console.log(req.url, 14);
    res.end(JSON.stringify(Index.list));
}

module.exports = {
    roadList,
};