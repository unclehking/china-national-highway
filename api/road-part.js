
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

//获取道路详情
function getRoadDetail(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const params = new URLSearchParams(url.search);
    const roadName = params.get('roadName');
    const partId = params.get('partId');
    const filePath = path.join(__dirname, `../db/${roadName}/${partId}.json`);
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(JSON.stringify(data));
}

//获取某国道所有part
function getRoadParts(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const params = new URLSearchParams(url.search);
    const roadName = params.get('roadName');
    console.log(roadName);
    try {
        // 获取roadName文件夹下所有文件
        const files = fs.readdirSync(path.join(__dirname, `../db/${roadName}/`));
        console.log('files:', files);
        const list = files.map(file => {
            const filePath = path.join(__dirname, `../db/${roadName}/${file}`);
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            let { coordinates } = data.geometry;
            return {
                _id: file.replace('.json', ''),
                name: roadName,
                description: data.properties.description,
                distance: data.properties.distance,
                index: data.properties.index,
                firstPoint: coordinates[0],
                lastPoint: coordinates[coordinates.length - 1],
            };
        });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(JSON.stringify({
            status: 1,
            message: '请求成功',
            list
        }));
    } catch (error) {
        console.log(error);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(JSON.stringify({
            status: 1,
            list: [],
        }));
        
    }
  
}

module.exports = {
    roadList,
    addPath,
    removeRoadPart,
    getRoadDetail,
    getRoadParts,
};