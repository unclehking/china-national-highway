
const fs = require('fs');
const path = require('path');
const db = require('node-little-db');
//列表
function roadList(req, res) {
    const Index = db.use('road-index');
    res.end(JSON.stringify(Index.list));
}

//新增path
function addPath(req, res) {
    
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    req.on('end', () => {
        // 在这里可以使用 body 变量来处理POST数据
        console.log('POST数据：', body);
        let postData = JSON.parse(body);

        let { index, description, coordinates, road, distance, status } = postData;
        console.log(index, description, coordinates, road, distance);
        
        const Part = db.use(
            `${road}-part-${index}`, 
            { 
                path: `./db/${road}`, 
                initialData: {
                    type: "Feature",
                    geometry: {
                        type: "Polyline",
                        coordinates,
                    },
                    properties: {
                        index,
                        description,
                        road,
                        distance,
                        status,
                    }
                }
            }
        );
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(JSON.stringify({
            status: 1,
            message: '新增成功',
            index, description, coordinates, road, distance
        }));
    });
    return;
    
    
}
//删除road part
function removeRoadPart(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const params = new URLSearchParams(url.search);
    const partName = params.get('partName');
    const roadName = partName.split('-')[0];
    console.log(partName);
    try {
        const filePath = path.join(__dirname, `../db/${roadName}`, partName+'.json');
        fs.unlinkSync(filePath);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(JSON.stringify({
            status: 1,
            message: '删除成功',
        }));
    } catch (error) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(JSON.stringify({
            status: 1,
            message: '删除失败',
        }));
    }
  
}

module.exports = {
    roadList,
    addPath,
    removeRoadPart,
};