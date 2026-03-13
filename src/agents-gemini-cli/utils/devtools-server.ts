/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { INDEX_HTML, CLIENT_JS } from './assets.js';

export interface SessionInfo {
  sessionId: string;
  ws: WebSocket;
  lastPing: number;
}

export class DevTools extends EventEmitter {
  private static instance: DevTools | undefined;
  private logs: any[] = [];
  private consoleLogs: any[] = [];
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, SessionInfo>();
  private port = 25417;

  private constructor() {
    super();
    this.setMaxListeners(50);
  }

  static getInstance(): DevTools {
    if (!DevTools.instance) {
      DevTools.instance = new DevTools();
    }
    return DevTools.instance;
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        resolve(`http://127.0.0.1:${this.port}`);
        return;
      }

      this.server = http.createServer((req, res) => {
        if (req.url === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const snapshot = JSON.stringify({
            networkLogs: this.logs,
            consoleLogs: this.consoleLogs,
            sessions: Array.from(this.sessions.keys()),
          });
          res.write(`event: snapshot\ndata: ${snapshot}\n\n`);

          const onNetwork = (log: any) => {
            res.write(`event: network\ndata: ${JSON.stringify(log)}\n\n`);
          };
          const onConsole = (log: any) => {
            res.write(`event: console\ndata: ${JSON.stringify(log)}\n\n`);
          };
          const onSession = () => {
            const sessions = Array.from(this.sessions.keys());
            res.write(`event: session\ndata: ${JSON.stringify(sessions)}\n\n`);
          };

          this.on('update', onNetwork);
          this.on('console-update', onConsole);
          this.on('session-update', onSession);

          req.on('close', () => {
            this.off('update', onNetwork);
            this.off('console-update', onConsole);
            this.off('session-update', onSession);
          });
        } else if (req.url === '/' || req.url === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(INDEX_HTML);
        } else if (req.url === '/assets/main.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(CLIENT_JS);
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.wss = new WebSocketServer({ server: this.server!, path: '/ws' });
        this.wss.on('connection', (ws: WebSocket) => {
          let sessionId: string | null = null;
          ws.on('message', (data: Buffer) => {
            try {
              const message = JSON.parse(data.toString());
              if (message.type === 'register') {
                sessionId = message.sessionId;
                this.sessions.set(sessionId!, { sessionId: sessionId!, ws, lastPing: Date.now() });
                this.emit('session-update');
                ws.send(JSON.stringify({ type: 'registered', sessionId, timestamp: Date.now() }));
              } else if (sessionId) {
                if (message.type === 'network') {
                  const log = { ...message.payload, sessionId, id: message.payload.id || randomUUID(), timestamp: message.timestamp || Date.now() };
                  const existingIndex = this.logs.findIndex(l => l.id === log.id);
                  if (existingIndex > -1) {
                    this.logs[existingIndex] = { ...this.logs[existingIndex], ...log };
                    this.emit('update', this.logs[existingIndex]);
                  } else {
                    this.logs.push(log);
                    this.emit('update', log);
                  }
                } else if (message.type === 'console') {
                  const log = { ...message.payload, sessionId, id: randomUUID(), timestamp: message.timestamp || Date.now() };
                  this.consoleLogs.push(log);
                  this.emit('console-update', log);
                }
              }
            } catch (e) {}
          });
          ws.on('close', () => {
            if (sessionId) {
              this.sessions.delete(sessionId);
              this.emit('session-update');
            }
          });
        });
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  getPort() {
    return this.port;
  }
}
