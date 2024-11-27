const http = require('http');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const os = require('os');
const port = 3000; // 服务器端口
const hostname = '127.0.0.1'; // 服务器地址
const directory = path.join(__dirname, './'); // 静态文件目录
const Api = require('./api/index')


const server = http.createServer((req, res) => {
    console.log(req.url,11111);
    // api
    if (req.url.includes('/api')) {
        switch (req.url) {
            case '/api/roadList':
                Api.roadList(req, res);
                break;
            default:
                res.writeHead(404, 'Not Found');
                res.end('404 Not Found');
                break;
        }
    }else {
        const filePath = path.join(directory, req.url);
        fs.access(filePath, fs.constants.F_OK, (err) => {
            if (err) {
                res.writeHead(404, 'Not Found');
                res.end('404 Not Found');
            } else {
                fs.readFile(filePath, (err, data) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('500 Internal Server Error');
                    } else {
                        res.writeHead(200);
                        res.end(data);
                    }
                });
            }
        });
    }
});

server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
});

//打开浏览器
const openWebUrl = (url) => {
    let type = os.platform()
    switch (type) {
            case 'win32':   //windows系统
            exec(`start ${url}`)
        break
        case 'darwin':  //苹果系统
            exec(`open ${url}`)
            break
        default:  //linux系统
            exec(`xdg-open ${url}`)
    }
}

const args = process.argv.slice(2);
if (args[0] === '--open') {
    openWebUrl(`http://${hostname}:${port}/index.html`);
}
