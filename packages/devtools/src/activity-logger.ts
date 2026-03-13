/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */

import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

export interface NetworkLog {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  pending?: boolean;
  response?: {
    status: number;
    headers: Record<string, string>;
    body?: string;
    durationMs: number;
  };
  error?: string;
}

export class ActivityLogger extends EventEmitter {
  private static instance: ActivityLogger;
  private isInterceptionEnabled = false;
  private requestStartTimes = new Map<string, number>();
  private ws: WebSocket | null = null;
  private sessionId: string;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  static getInstance(sessionId: string): ActivityLogger {
    if (!ActivityLogger.instance) {
      ActivityLogger.instance = new ActivityLogger(sessionId);
    }
    return ActivityLogger.instance;
  }

  enable() {
    if (this.isInterceptionEnabled) return;
    this.isInterceptionEnabled = true;
    this.patchGlobalFetch();
    this.patchNodeHttp();
  }

  async connectDevTools(host: string, port: number) {
    this.ws = new WebSocket(`ws://${host}:${port}/ws`);
    return new Promise<void>((resolve, reject) => {
      this.ws?.on('open', () => {
        this.ws?.send(JSON.stringify({
          type: 'register',
          sessionId: this.sessionId,
          timestamp: Date.now(),
        }));
        resolve();
      });
      this.ws?.on('error', reject);
    });
  }

  private sendToDevTools(type: 'network' | 'console', payload: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type,
        payload,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      }));
    }
  }

  private stringifyHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {};
    if (!headers) return result;
    if (headers instanceof Headers) {
      headers.forEach((v, k) => { result[k.toLowerCase()] = v; });
    } else {
      for (const [k, v] of Object.entries(headers)) {
        result[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      }
    }
    return result;
  }

  private patchGlobalFetch() {
    if (!global.fetch) return;
    const originalFetch = global.fetch;
    global.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('127.0.0.1') || url.includes('localhost')) return originalFetch(input, init);

      const id = Math.random().toString(36).substring(7);
      const method = (init?.method || 'GET').toUpperCase();
      this.requestStartTimes.set(id, Date.now());

      let body = '';
      if (init?.body) {
        if (typeof init.body === 'string') body = init.body;
        else if (init.body instanceof URLSearchParams) body = init.body.toString();
      }

      this.sendToDevTools('network', {
        id, timestamp: Date.now(), method, url, 
        headers: this.stringifyHeaders(init?.headers), body, pending: true,
      });

      try {
        const response = await originalFetch(input, init);
        const clonedRes = response.clone();
        const resBody = await clonedRes.text();
        const durationMs = Date.now() - (this.requestStartTimes.get(id) || Date.now());

        this.sendToDevTools('network', {
          id, pending: false,
          response: { status: response.status, headers: this.stringifyHeaders(response.headers), body: resBody, durationMs },
        });
        return response;
      } catch (err: any) {
        this.sendToDevTools('network', { id, pending: false, error: err.message });
        throw err;
      }
    };
  }

  private patchNodeHttp() {
    const wrapRequest = (originalFn: any, protocol: string) => {
      return (...args: any[]) => {
        const req = originalFn(...args);
        const url = `${protocol}//${req.getHeader('host')}${req.path}`;
        if (url.includes('127.0.0.1') || url.includes('localhost')) return req;

        const id = Math.random().toString(36).substring(7);
        this.requestStartTimes.set(id, Date.now());

        const oldEnd = req.end;
        const chunks: any[] = [];
        const oldWrite = req.write;
        req.write = (chunk: any, ...etc: any[]) => {
          if (chunk) chunks.push(Buffer.from(chunk));
          return oldWrite.apply(req, [chunk, ...etc]);
        };

        req.end = (chunk: any, ...etc: any[]) => {
          if (chunk) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString('utf8');
          this.sendToDevTools('network', {
            id, timestamp: Date.now(), method: req.method || 'GET', url,
            headers: this.stringifyHeaders(req.getHeaders()), body, pending: true,
          });
          return oldEnd.apply(req, [chunk, ...etc]);
        };

        req.on('response', (res: any) => {
          const resChunks: any[] = [];
          res.on('data', (c: any) => resChunks.push(c));
          res.on('end', () => {
            const resBody = Buffer.concat(resChunks).toString('utf8');
            const durationMs = Date.now() - (this.requestStartTimes.get(id) || Date.now());
            this.sendToDevTools('network', {
              id, pending: false,
              response: { status: res.statusCode, headers: this.stringifyHeaders(res.headers), body: resBody, durationMs },
            });
          });
        });
        return req;
      };
    };

    http.request = wrapRequest(http.request, 'http:');
    https.request = wrapRequest(https.request, 'https:');
  }
}
