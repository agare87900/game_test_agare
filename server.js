// Basic Node/Express + WebSocket server for the Voxel game
// Run with: npm install && npm start
// You may supply port, host, and optional password on the command line,
// e.g. node server.js 3000 0.0.0.0 mypassword

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = parseInt(process.argv[2], 10) || process.env.PORT || 3000;
// allow specifying listening host/IP; default to all interfaces (0.0.0.0)
const HOST = process.argv[3] || process.env.HOST || '0.0.0.0';
// optional server password (empty = no password)
const PASSWORD = process.argv[4] || process.env.PASSWORD || '';

const app = express();
// serve everything in the workspace root (static files, images, etc.)
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// simple state for connected clients
const clients = new Map(); // ws -> {id,name,team,x,y,z,yaw}
let nextId = 1;

function broadcast(payload, exceptWs) {
  const msg = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws !== exceptWs) {
      ws.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  const id = nextId++;
  let authenticated = false;
  let state = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // first message should be hello to authenticate
      if (!authenticated) {
        if (msg.type === 'hello') {
          // verify password if required
          if (PASSWORD && msg.password !== PASSWORD) {
            ws.send(JSON.stringify({ type: 'error', text: 'invalid password' }));
            ws.close();
            return;
          }
          // create state now that we have name/team
          state = { id, name: msg.name || `Player${id}`, team: msg.team || 'red', x: 0, y: 70, z: 0, yaw: 0 };
          clients.set(ws, state);
          authenticated = true;

          // welcome packet + existing players
          ws.send(JSON.stringify({ type: 'welcome', id, players: Array.from(clients.values()) }));
          broadcast({ type: 'join', player: state }, ws);
          broadcast({ type: 'chat', name: 'Server', text: `${state.name} connected` }, ws);
        }
        return;
      }

      // after authentication, look up state normally
      const st = clients.get(ws);
      if (!st) return;

      switch (msg.type) {
        case 'state':
          st.x = msg.x; st.y = msg.y; st.z = msg.z; st.yaw = msg.yaw;
          broadcast({ type: 'state', id: st.id, x: st.x, y: st.y, z: st.z, yaw: st.yaw }, ws);
          break;
        case 'blockChange':
          broadcast({
            type: 'blockChange',
            x: msg.x,
            y: msg.y,
            z: msg.z,
            blockType: msg.blockType
          }, ws);
          break;
        case 'chat':
          // relay chat message to everyone else (include sender info)
          broadcast({
            type: 'chat',
            id: st.id,
            name: st.name,
            text: msg.text
          }, ws);
          break;
      }
    } catch (e) {
      console.error('failed parsing message', e);
    }
  });

  ws.on('close', () => {
    const st = clients.get(ws);
    clients.delete(ws);
    if (st) {
      broadcast({ type: 'leave', id: st.id });
      broadcast({ type: 'chat', name: 'Server', text: `${st.name} disconnected` });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
});
