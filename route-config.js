/**
 * 路由配置指南
 * 
 * 在服务器主文件（通常是server.js、app.js或index.js）中添加以下路由配置：
 */

// 找到类似这样的代码块
// app.get('/api/roadList', require('./api/index').roadList);
// app.post('/api/addRoad', require('./api/index').addRoad);
// app.post('/api/updateRoad', require('./api/index').updateRoad);

// 添加以下行来注册删除路由
// app.get('/api/deleteRoad', require('./api/index').deleteRoad);

/**
 * 完整的路由配置示例：
 * 
 * // 国道管理API
 * app.get('/api/roadList', require('./api/index').roadList);
 * app.post('/api/addRoad', require('./api/index').addRoad);
 * app.post('/api/updateRoad', require('./api/index').updateRoad);
 * app.get('/api/deleteRoad', require('./api/index').deleteRoad);
 * 
 * // 路段管理API
 * app.get('/api/getRoadParts', require('./api/road-part').getRoadParts);
 * app.get('/api/getRoadDetail', require('./api/road-part').getRoadDetail);
 * app.get('/api/removeRoadPart', require('./api/road-part').removeRoadPart);
 * app.post('/api/addPath', require('./api/road-part').addPath);
 */ 