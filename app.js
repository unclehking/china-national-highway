// 国道管理API
app.get('/api/roadList', require('./api/index').roadList);
app.post('/api/addRoad', require('./api/index').addRoad);
app.post('/api/updateRoad', require('./api/index').updateRoad);
app.get('/api/deleteRoad', require('./api/index').deleteRoad); 