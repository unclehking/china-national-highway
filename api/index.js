const fs = require('fs');
const path = require('path');
const db = require('node-little-db');
//列表
function roadList(req, res) {
    try {
        // 直接读取road-index.json文件
        const indexFilePath = path.join(__dirname, '../db/road-index.json');
        const indexData = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(indexData.list));
    } catch (error) {
        console.error('获取国道列表失败:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 0,
            message: '服务器错误'
        }));
    }
}

// 新增国道
function addRoad(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    req.on('end', () => {
        try {
            console.log('POST数据：', body);
            const roadData = JSON.parse(body);
            
            // 验证必填字段
            if (!roadData.name || !roadData.subTitle) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    status: 0,
                    message: '名称和描述为必填项'
                }));
            }

            // 读取road-index.json文件
            const indexFilePath = path.join(__dirname, '../db/road-index.json');
            const indexData = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
            
            // 提取需要的字段
            const newRoad = {
                name: roadData.name,
                subTitle: roadData.subTitle,
                status: Number(roadData.status || 0),
                index: Number(roadData.index || indexData.list.length)
            };
            
            // 检查是否已存在相同名称的国道
            const existingRoad = indexData.list.find(road => road.name === newRoad.name);
            if (existingRoad) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    status: 0,
                    message: `国道${newRoad.name}已存在`
                }));
            }
            
            // 添加到数据
            indexData.list.push(newRoad);
            
            // 直接写入文件保存
            fs.writeFileSync(indexFilePath, JSON.stringify(indexData, null, 2));
            
            // 创建该国道的数据目录
            const dirPath = path.join(__dirname, `../db/${newRoad.name}`);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }
            
            // 返回成功信息
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 1,
                message: '添加成功',
                data: newRoad
            }));
        } catch (error) {
            console.error('添加国道失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 0,
                message: '服务器错误'
            }));
        }
    });
}

// 更新国道
function updateRoad(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    req.on('end', () => {
        try {
            console.log('POST数据：', body);
            const roadData = JSON.parse(body);
            
            // 验证必填字段
            if (!roadData.name || !roadData.subTitle) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    status: 0,
                    message: '名称和描述为必填项'
                }));
            }

            // 读取road-index.json文件
            const indexFilePath = path.join(__dirname, '../db/road-index.json');
            const indexData = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
            
            // 查找要更新的记录，优先使用originalName查找
            const searchName = roadData.originalName || roadData.name;
            const index = indexData.list.findIndex(item => item.name === searchName);
            
            if (index === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    status: 0,
                    message: '未找到该国道记录'
                }));
            }
            
            // 如果名称变更了，检查新名称是否已存在
            if (roadData.originalName && roadData.name !== roadData.originalName) {
                const nameExists = indexData.list.some(item => 
                    item.name === roadData.name && item.name !== roadData.originalName
                );
                
                if (nameExists) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        status: 0,
                        message: `国道${roadData.name}已存在`
                    }));
                }
                
                // 如果国道名称变更，需要处理数据目录
                const oldDirPath = path.join(__dirname, `../db/${roadData.originalName}`);
                const newDirPath = path.join(__dirname, `../db/${roadData.name}`);
                
                // 如果原目录存在且新目录不存在，则重命名目录
                if (fs.existsSync(oldDirPath) && !fs.existsSync(newDirPath)) {
                    try {
                        fs.renameSync(oldDirPath, newDirPath);
                    } catch (err) {
                        console.error('重命名目录失败:', err);
                        // 创建新目录
                        if (!fs.existsSync(newDirPath)) {
                            fs.mkdirSync(newDirPath, { recursive: true });
                        }
                    }
                } else if (!fs.existsSync(newDirPath)) {
                    // 如果新目录不存在，创建新目录
                    fs.mkdirSync(newDirPath, { recursive: true });
                }
            }
            
            // 更新记录
            indexData.list[index] = {
                name: roadData.name,
                subTitle: roadData.subTitle,
                status: Number(roadData.status || 0),
                index: Number(roadData.index || 0)
            };
            
            // 直接写入文件保存
            fs.writeFileSync(indexFilePath, JSON.stringify(indexData, null, 2));
            
            // 返回成功信息
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 1,
                message: '更新成功',
                data: indexData.list[index]
            }));
        } catch (error) {
            console.error('更新国道失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 0,
                message: '服务器错误'
            }));
        }
    });
}

// 删除国道
function deleteRoad(req, res) {
    try {
        // 获取要删除的国道名称
        const url = new URL(req.url, `http://${req.headers.host}`);
        const params = new URLSearchParams(url.search);
        const roadName = params.get('name');
        
        if (!roadName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                status: 0,
                message: '缺少国道名称参数'
            }));
        }
        
        // 读取road-index.json文件
        const indexFilePath = path.join(__dirname, '../db/road-index.json');
        const indexData = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
        
        // 查找要删除的记录
        const index = indexData.list.findIndex(item => item.name === roadName);
        
        if (index === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                status: 0,
                message: '未找到该国道记录'
            }));
        }
        
        // 删除记录
        const deletedRoad = indexData.list.splice(index, 1)[0];
        
        // 保存数据
        fs.writeFileSync(indexFilePath, JSON.stringify(indexData, null, 2));
        
        // 可选：备份国道数据目录
        const dirPath = path.join(__dirname, `../db/${roadName}`);
        const backupPath = path.join(__dirname, `../db/_backup_${roadName}_${Date.now()}`);
        
        if (fs.existsSync(dirPath)) {
            try {
                // 重命名目录作为备份
                fs.renameSync(dirPath, backupPath);
            } catch (err) {
                console.error('备份目录失败:', err);
                // 删除失败不影响主流程
            }
        }
        
        // 返回成功信息
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 1,
            message: `国道${roadName}删除成功`,
            data: deletedRoad
        }));
    } catch (error) {
        console.error('删除国道失败:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 0,
            message: '服务器错误'
        }));
    }
}

module.exports = {
    roadList,
    addRoad,
    updateRoad,
    deleteRoad
};